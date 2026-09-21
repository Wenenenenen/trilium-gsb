import type { BranchRow, NoteRow } from "@triliumnext/commons";

import becca from "../becca/becca.js";
import BBranch from "../becca/entities/bbranch.js";
import entityChangesService from "./entity_changes.js";
import { getLog } from "./log.js";
import noteService from "./notes.js";
import { getSql } from "./sql/index.js";
import TaskContext from "./task_context.js";

/**
 * Server-side record of the most recent undoable tree-structure operation (branch moves, reorders
 * and deletes). Only a single operation is retained: starting a new operation replaces the previous
 * record. The record is built incrementally by the branch/note route handlers (a multi-select
 * operation arrives as several requests sharing one `undoGroupId`) and executed atomically by the
 * `POST /api/tree/undo` route, which runs inside a transaction.
 *
 * The undo is snapshot-based: before mutating, the routes capture the exact state of every branch
 * they touch (the moved/deleted branch itself plus its old and new siblings, whose positions may
 * shift). Undo then restores those snapshots, removes the clone branches the operation created and
 * undeletes any notes the operation deleted.
 */

export type TreeOperationKind = "move" | "delete";

interface BranchSnapshot {
    branchId: string;
    noteId: string;
    parentNoteId: string;
    prefix: string | null;
    notePosition: number;
    isExpanded: boolean;
}

export interface TreeUndoRecord {
    groupId: string;
    kind: TreeOperationKind;
    /** Exact pre-operation state of every affected branch, keyed by branchId (first snapshot wins). */
    branches: Map<string, BranchSnapshot>;
    /** BranchIds of clones created by the operation (a move is clone + delete); removed on undo. */
    createdBranchIds: Set<string>;
    /** Notes deleted by the operation, mapped to the deleteId they were deleted with. */
    deletedNotes: Map<string, string>;
    /** Parents whose children changed, used to emit note_reordering entity changes after undo. */
    affectedParentNoteIds: Set<string>;
    /** Whether at least one mutation has been successfully recorded. */
    committed: boolean;
}

export interface TreeUndoResult {
    success: boolean;
    message?: string;
}

/** The single retained undo record. Replaced whenever a new undoable tree operation commits. */
let currentRecord: TreeUndoRecord | null = null;

function createRecord(groupId: string, kind: TreeOperationKind): TreeUndoRecord {
    return {
        groupId,
        kind,
        branches: new Map(),
        createdBranchIds: new Set(),
        deletedNotes: new Map(),
        affectedParentNoteIds: new Set(),
        committed: false
    };
}

/**
 * Returns the record the caller should accumulate operation effects into, or `null` when the
 * request is not part of an undoable operation (no `undoGroupId`). The record becomes the retained
 * one only once {@link commitOperation} is called, so a failed operation does not clobber the
 * previous undo state. Requests sharing the groupId of the retained record keep appending to it.
 */
function beginOperation(groupId: string | undefined, kind: TreeOperationKind): TreeUndoRecord | null {
    if (!groupId || typeof groupId !== "string") {
        return null;
    }

    if (currentRecord?.groupId === groupId) {
        return currentRecord;
    }

    return createRecord(groupId, kind);
}

/** Marks the record as holding real changes and makes it the retained undo record. */
function commitOperation(record: TreeUndoRecord | null) {
    if (!record) {
        return;
    }

    record.committed = true;
    currentRecord = record;
}

function snapshotBranch(record: TreeUndoRecord, branch: BBranch) {
    if (!branch.branchId || record.branches.has(branch.branchId)) {
        return;
    }

    record.branches.set(branch.branchId, {
        branchId: branch.branchId,
        noteId: branch.noteId,
        parentNoteId: branch.parentNoteId,
        prefix: branch.prefix,
        notePosition: branch.notePosition,
        isExpanded: branch.isExpanded
    });
}

/**
 * Snapshots the given branch plus all of its parent's children (a move/reorder shifts sibling
 * positions, and undo must restore those too). Must be called before the mutation happens.
 */
function snapshotBranchWithSiblings(record: TreeUndoRecord, branch: BBranch) {
    snapshotBranch(record, branch);
    snapshotSiblingsOf(record, branch.parentNoteId);
}

/** Snapshots the current children positions of the given parent note. */
function snapshotSiblingsOf(record: TreeUndoRecord, parentNoteId: string) {
    const parentNote = becca.getNote(parentNoteId);

    if (!parentNote) {
        return;
    }

    record.affectedParentNoteIds.add(parentNoteId);

    for (const childBranch of parentNote.getChildBranches()) {
        snapshotBranch(record, childBranch);
    }
}

/** Records a clone branch created by a move so that undo can remove it again. */
function recordCreatedBranch(record: TreeUndoRecord, branchId: string, parentNoteId: string) {
    record.createdBranchIds.add(branchId);
    record.affectedParentNoteIds.add(parentNoteId);
}

/** Records a note deleted by the operation so that undo can restore it with its subtree. */
function recordDeletedNote(record: TreeUndoRecord, noteId: string, deleteId: string) {
    record.deletedNotes.set(noteId, deleteId);
}

function isNoteAlive(noteId: string): boolean {
    const row = getSql().getRowOrNull<Pick<NoteRow, "isDeleted">>("SELECT isDeleted FROM notes WHERE noteId = ?", [ noteId ]);
    return !!row && !row.isDeleted;
}

/**
 * Validates that the recorded operation can still be safely reversed. Returns an error message
 * when the tree context changed in a way that makes a faithful restore impossible (e.g. the
 * original parent was itself deleted in the meantime).
 */
function validateRecord(record: TreeUndoRecord): string | null {
    const sql = getSql();

    for (const snap of record.branches.values()) {
        const branchRow = sql.getRowOrNull<BranchRow>("SELECT branchId FROM branches WHERE branchId = ?", [ snap.branchId ]);

        if (!branchRow) {
            return `Cannot undo: a branch of note '${snap.noteId}' no longer exists (it may have been erased).`;
        }

        if (!isNoteAlive(snap.parentNoteId)) {
            return `Cannot undo: the original parent note of '${snap.noteId}' has been deleted.`;
        }

        const noteRow = sql.getRowOrNull<Pick<NoteRow, "isDeleted" | "deleteId">>("SELECT isDeleted, deleteId FROM notes WHERE noteId = ?", [ snap.noteId ]);

        if (!noteRow) {
            return `Cannot undo: note '${snap.noteId}' no longer exists (it may have been erased).`;
        }

        // The note may be deleted only when this very operation deleted it (and will restore it).
        // A note deleted by anything since cannot have its branches faithfully restored.
        if (noteRow.isDeleted && record.deletedNotes.get(snap.noteId) !== noteRow.deleteId) {
            return `Cannot undo: note '${snap.noteId}' has been deleted since the operation.`;
        }
    }

    for (const [ noteId, deleteId ] of record.deletedNotes) {
        const noteRow = sql.getRowOrNull<NoteRow>("SELECT * FROM notes WHERE noteId = ?", [ noteId ]);

        if (!noteRow) {
            return `Cannot undo: note '${noteId}' has been erased and can no longer be restored.`;
        }

        if (!noteRow.isDeleted || noteRow.deleteId !== deleteId) {
            return `Cannot undo: note '${noteId}' has already been restored or changed since the operation.`;
        }

        // The note can only be restored if at least one of its original parents is still alive.
        const restorableParents = sql.getRows<BranchRow>(
            "SELECT parentNoteId FROM branches WHERE noteId = ? AND deleteId = ? AND isDeleted = 1",
            [ noteId, deleteId ]
        ).filter((row) => isNoteAlive(row.parentNoteId));

        if (restorableParents.length === 0) {
            return `Cannot undo: the original parent note of '${noteId}' has been deleted.`;
        }
    }

    return null;
}

/**
 * Atomically reverses the retained tree operation. Intended to be called from within a
 * transaction (the undo route is transactional): known unsafe conditions are detected up front
 * and reported without touching any data, while an unexpected mid-restore failure propagates and
 * rolls the transaction back, so a failed undo never leaves a partially restored tree.
 */
function undoLastTreeOperation(): TreeUndoResult {
    const record = currentRecord;

    if (!record || !record.committed) {
        return { success: false, message: "There is no tree operation to undo." };
    }

    const validationError = validateRecord(record);

    if (validationError) {
        getLog().info(`Tree undo refused: ${validationError}`);
        return { success: false, message: validationError };
    }

    // Restore notes deleted by the operation, together with their deleted subtrees.
    for (const noteId of record.deletedNotes.keys()) {
        const taskContext = new TaskContext("no-progress-reporting", "undeleteNotes", null);
        const result = noteService.undeleteNote(noteId, taskContext);

        if (!result.undeleted) {
            // Defensive: validation above should have caught every legitimate cause. Throwing
            // (rather than returning) rolls the transaction back so nothing is half-restored.
            throw new Error(`Failed to restore note '${noteId}' during tree undo.`);
        }
    }

    // Restore every affected branch to its exact pre-operation state. Saving a BBranch upserts
    // with isDeleted = 0, which also un-deletes branches the operation had deleted.
    for (const snap of record.branches.values()) {
        new BBranch({
            branchId: snap.branchId,
            noteId: snap.noteId,
            parentNoteId: snap.parentNoteId,
            prefix: snap.prefix,
            notePosition: snap.notePosition,
            isExpanded: snap.isExpanded
        }).save();
    }

    // Remove the clone branches the operation created. Done after the restore so a moved note
    // never transiently ends up parentless.
    for (const branchId of record.createdBranchIds) {
        const branch = becca.getBranch(branchId);

        if (branch) {
            branch.markAsDeleted();
        }
    }

    for (const parentNoteId of record.affectedParentNoteIds) {
        entityChangesService.putNoteReorderingEntityChange(parentNoteId);
    }

    currentRecord = null;

    getLog().info(`Undid tree operation '${record.groupId}' (${record.kind}).`);

    return { success: true };
}

/** Test-only hook: drops the retained record so specs don't leak state into each other. */
function resetForTests() {
    currentRecord = null;
}

export default {
    beginOperation,
    commitOperation,
    snapshotBranchWithSiblings,
    snapshotSiblingsOf,
    recordCreatedBranch,
    recordDeletedNote,
    undoLastTreeOperation,
    resetForTests
};
