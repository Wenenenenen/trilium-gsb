import type { BranchRow, NoteRow } from "@triliumnext/commons";

import becca from "../becca/becca.js";
import type BBranch from "../becca/entities/bbranch.js";
import entityChangesService from "./entity_changes.js";
import { getLog } from "./log.js";
import noteService from "./notes.js";
import { getSql } from "./sql/index.js";
import TaskContext from "./task_context.js";
import treeService from "./tree.js";

/**
 * Remembers the most recent user-initiated tree structure operation (move, reorder, delete) so
 * it can be undone once. Only a single operation is kept: recording a new one (identified by its
 * taskId, which the client generates per user gesture) replaces the previous record. The record
 * lives in memory only — undo is a convenience for immediate mistakes, not a persistent history.
 */

interface MovedBranch {
    noteId: string;
    fromParentNoteId: string;
    toParentNoteId: string;
}

interface ParentSnapshot {
    parentNoteId: string;
    /**
     * notePosition by branchId for every child of the parent, captured before the operation
     * first touched it.
     */
    childPositions: Record<string, number>;
}

interface DeletedBranch {
    branchId: string;
    deleteId: string;
}

interface DeletedNote {
    noteId: string;
    deleteId: string;
}

interface TreeUndoRecord {
    taskId: string;
    movedBranches: MovedBranch[];
    parentSnapshots: ParentSnapshot[];
    deletedBranches: DeletedBranch[];
    deletedNotes: DeletedNote[];
}

export interface TreeUndoResult {
    success: boolean;
    message?: string;
}

let currentRecord: TreeUndoRecord | null = null;

function getOrCreateRecord(taskId: string): TreeUndoRecord {
    if (!currentRecord || currentRecord.taskId !== taskId) {
        currentRecord = {
            taskId,
            movedBranches: [],
            parentSnapshots: [],
            deletedBranches: [],
            deletedNotes: []
        };
    }

    return currentRecord;
}

function snapshotParent(record: TreeUndoRecord, parentNoteId: string) {
    if (record.parentSnapshots.some((snapshot) => snapshot.parentNoteId === parentNoteId)) {
        return;
    }

    const parentNote = becca.getNote(parentNoteId);
    if (!parentNote) {
        return;
    }

    const childPositions: Record<string, number> = {};
    for (const childBranch of parentNote.getChildBranches()) {
        if (childBranch.branchId) {
            childPositions[childBranch.branchId] = childBranch.notePosition;
        }
    }

    record.parentSnapshots.push({ parentNoteId, childPositions });
}

/**
 * Records a branch move (or same-parent reorder) before it is applied, so {@link undoLastOperation}
 * can restore the original parents and positions. Must be called before the mutation, and only
 * when the move is known to pass validation.
 */
function recordBranchMove(taskId: string, branchToMove: BBranch, targetParentNoteId: string) {
    const record = getOrCreateRecord(taskId);

    snapshotParent(record, branchToMove.parentNoteId);
    snapshotParent(record, targetParentNoteId);

    record.movedBranches.push({
        noteId: branchToMove.noteId,
        fromParentNoteId: branchToMove.parentNoteId,
        toParentNoteId: targetParentNoteId
    });
}

/** Records a soft-deleted branch so {@link undoLastOperation} can undelete it in place. */
function recordBranchDeletion(taskId: string, branchId: string, deleteId: string) {
    getOrCreateRecord(taskId).deletedBranches.push({ branchId, deleteId });
}

/**
 * Records a soft-deleted note (all clones) so {@link undoLastOperation} can restore it with
 * its subtree.
 */
function recordNoteDeletion(taskId: string, noteId: string, deleteId: string) {
    getOrCreateRecord(taskId).deletedNotes.push({ noteId, deleteId });
}

/** Drops the recorded operation without undoing it. */
function clearTreeUndo() {
    currentRecord = null;
}

/**
 * Undoes the most recently recorded tree operation as a single transaction: any failure (e.g. the
 * original parent was deleted in the meantime) rolls everything back and is reported to the caller,
 * leaving the tree exactly as it was before the attempt.
 */
function undoLastOperation(): TreeUndoResult {
    const record = currentRecord;

    if (!record) {
        return { success: false, message: "There is no tree structure change to undo." };
    }

    try {
        getSql().transactional(() => {
            undoMoves(record);
            undoDeletions(record);
        });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        getLog().error(`Undoing tree structure change failed: ${message}`);
        return { success: false, message };
    }

    currentRecord = null;
    getLog().info(`Undid tree structure change recorded as task '${record.taskId}'`);
    return { success: true };
}

function undoMoves(record: TreeUndoRecord) {
    // Move branches back in reverse order, so multi-branch moves rebuild the original structure.
    for (const move of record.movedBranches.slice().reverse()) {
        if (move.fromParentNoteId === move.toParentNoteId) {
            // Same-parent reorder: only positions changed, the snapshot restore below handles it.
            continue;
        }

        const currentBranch = becca.getBranchFromChildAndParent(move.noteId, move.toParentNoteId);
        if (!currentBranch?.branchId) {
            throw new Error(
                "Cannot undo the change: a moved note is no longer where the operation placed it."
            );
        }

        if (!becca.getNote(move.fromParentNoteId)) {
            throw new Error("Cannot undo the change: the original parent note no longer exists.");
        }

        const validationResult = treeService.validateParentChild(
            move.fromParentNoteId,
            move.noteId,
            currentBranch.branchId
        );
        if (!validationResult.success) {
            throw new Error(`Cannot undo the change: ${validationResult.message}`);
        }

        const restoredBranch = currentBranch.createClone(move.fromParentNoteId);
        restoredBranch.save();
        currentBranch.markAsDeleted();
    }

    // Restore the exact pre-operation positions of every child of every touched parent. Branches
    // created or deleted after the recorded operation are left alone.
    for (const snapshot of record.parentSnapshots) {
        if (!becca.getNote(snapshot.parentNoteId)) {
            continue;
        }

        for (const [ branchId, notePosition ] of Object.entries(snapshot.childPositions)) {
            const branch = becca.getBranch(branchId);
            if (branch && branch.notePosition !== notePosition) {
                branch.notePosition = notePosition;
                branch.save();
            }
        }

        treeService.sortNotesIfNeeded(snapshot.parentNoteId);
        entityChangesService.putNoteReorderingEntityChange(snapshot.parentNoteId);
    }
}

function undoDeletions(record: TreeUndoRecord) {
    const taskContext = new TaskContext("no-progress-reporting", "undeleteNotes", null);
    const sql = getSql();

    for (const deleted of record.deletedBranches.slice().reverse()) {
        const branchRow = sql.getRowOrNull<BranchRow>(
            "SELECT * FROM branches WHERE branchId = ?",
            [ deleted.branchId ]
        );

        if (!branchRow) {
            throw new Error("Cannot undo the deletion: the branch has already been erased.");
        }

        if (!branchRow.isDeleted) {
            continue;
        }

        if (!becca.getNote(branchRow.parentNoteId)) {
            throw new Error(
                "Cannot undo the deletion: the parent note of a deleted branch no longer exists."
            );
        }

        const noteRow = sql.getRowOrNull<NoteRow>(
            "SELECT * FROM notes WHERE noteId = ?",
            [ branchRow.noteId ]
        );

        if (!noteRow) {
            throw new Error("Cannot undo the deletion: a deleted note has already been erased.");
        }

        if (noteRow.isDeleted && noteRow.deleteId !== deleted.deleteId) {
            throw new Error(
                "Cannot undo the deletion: the note has been deleted again by a later operation."
            );
        }

        noteService.undeleteBranch(deleted.branchId, deleted.deleteId, taskContext);
    }

    for (const deleted of record.deletedNotes.slice().reverse()) {
        // Every clone of the note is restored under its original parent, so all of those parents
        // must still be alive for the undo to be safe.
        const parentBranchRows = sql.getRows<Pick<BranchRow, "parentNoteId">>(
            "SELECT parentNoteId FROM branches WHERE noteId = ? AND isDeleted = 1 AND deleteId = ?",
            [ deleted.noteId, deleted.deleteId ]
        );

        for (const parentBranchRow of parentBranchRows) {
            if (!becca.getNote(parentBranchRow.parentNoteId)) {
                throw new Error(
                    "Cannot undo the deletion: a parent note of the deleted note no longer exists."
                );
            }
        }

        const result = noteService.undeleteNote(deleted.noteId, taskContext);

        if (!result.undeleted) {
            throw new Error(
                "Cannot undo the deletion: the note could not be restored" +
                    " (it may have been erased)."
            );
        }
    }
}

export default {
    recordBranchMove,
    recordBranchDeletion,
    recordNoteDeletion,
    undoLastOperation,
    clearTreeUndo
};
