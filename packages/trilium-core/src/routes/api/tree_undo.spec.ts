import { beforeEach, describe, expect, it } from "vitest";

import { getSql } from "../../services/sql/index";
import treeUndoService from "../../services/tree_undo";
import { createTextNote } from "../../test/api_fixtures";
import { CoreApiTester } from "../../test/api_tester";

/**
 * Covers the single-slot tree-structure undo (move / reorder / delete) exposed via
 * `POST /api/tree/undo`, driven through the real core routes with `undoGroupId`.
 */

let api: CoreApiTester;

interface UndoResponse {
    success: boolean;
    message?: string;
}

function branchRow(branchId: string) {
    return getSql().getRowOrNull<{
        parentNoteId: string;
        notePosition: number;
        isDeleted: number;
    }>("SELECT parentNoteId, notePosition, isDeleted FROM branches WHERE branchId = ?", [ branchId ]);
}

function childNoteIds(parentNoteId: string): string[] {
    return getSql()
        .getRows<{ noteId: string }>(
            "SELECT noteId FROM branches WHERE parentNoteId = ? AND isDeleted = 0 ORDER BY notePosition",
            [ parentNoteId ]
        )
        .map((row) => row.noteId);
}

function noteIsDeleted(noteId: string): number {
    return getSql().getValue<number>("SELECT isDeleted FROM notes WHERE noteId = ?", [ noteId ]);
}

async function undo() {
    return await api.post<UndoResponse>("/api/tree/undo");
}

describe("Tree undo API (core)", () => {
    beforeEach(() => {
        api = CoreApiTester.build();
        treeUndoService.resetForTests();
    });

    it("reports failure when there is nothing to undo", async () => {
        const res = await undo();
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
    });

    it("undoes a single branch move, restoring parent and position", async () => {
        const source = await createTextNote(api, { title: "Undo move source" });
        const target = await createTextNote(api, { title: "Undo move target" });
        const child = await createTextNote(api, { parentNoteId: source.noteId, title: "Undo move child" });

        const originalPosition = branchRow(child.branchId)?.notePosition;

        const move = await api.put<{ success: boolean }>(
            `/api/branches/${child.branchId}/move-to/${target.branchId}?undoGroupId=move-1`
        );
        expect(move.body.success).toBe(true);
        expect(branchRow(child.branchId)?.isDeleted).toBe(1);
        expect(childNoteIds(target.noteId)).toEqual([ child.noteId ]);

        const res = await undo();
        expect(res.body.success).toBe(true);

        // The original branch is restored with its exact position, the created clone is gone.
        expect(branchRow(child.branchId)?.isDeleted).toBe(0);
        expect(branchRow(child.branchId)?.notePosition).toBe(originalPosition);
        expect(childNoteIds(source.noteId)).toEqual([ child.noteId ]);
        expect(childNoteIds(target.noteId)).toEqual([]);
    });

    it("undoes a multi-branch move restoring the original relative order", async () => {
        const source = await createTextNote(api, { title: "Multi source" });
        const target = await createTextNote(api, { title: "Multi target" });
        const first = await createTextNote(api, { parentNoteId: source.noteId, title: "Multi first" });
        const second = await createTextNote(api, { parentNoteId: source.noteId, title: "Multi second" });
        const third = await createTextNote(api, { parentNoteId: source.noteId, title: "Multi third" });

        const originalPositions = [ first, second, third ].map((n) => branchRow(n.branchId)?.notePosition);

        // Both moves belong to a single undoable operation.
        await api.put(`/api/branches/${first.branchId}/move-to/${target.branchId}?undoGroupId=multi-1`);
        await api.put(`/api/branches/${second.branchId}/move-to/${target.branchId}?undoGroupId=multi-1`);
        expect(childNoteIds(target.noteId)).toEqual([ first.noteId, second.noteId ]);

        const res = await undo();
        expect(res.body.success).toBe(true);

        expect(childNoteIds(source.noteId)).toEqual([ first.noteId, second.noteId, third.noteId ]);
        expect([ first, second, third ].map((n) => branchRow(n.branchId)?.notePosition)).toEqual(originalPositions);
        expect(childNoteIds(target.noteId)).toEqual([]);
    });

    it("undoes a reorder within the same parent", async () => {
        const parent = await createTextNote(api, { title: "Reorder undo parent" });
        const first = await createTextNote(api, { parentNoteId: parent.noteId, title: "Reorder first" });
        const second = await createTextNote(api, { parentNoteId: parent.noteId, title: "Reorder second" });
        const third = await createTextNote(api, { parentNoteId: parent.noteId, title: "Reorder third" });

        const originalPositions = [ first, second, third ].map((n) => branchRow(n.branchId)?.notePosition);

        const move = await api.put<{ success: boolean }>(
            `/api/branches/${third.branchId}/move-before/${first.branchId}?undoGroupId=reorder-1`
        );
        expect(move.body.success).toBe(true);
        expect(childNoteIds(parent.noteId)).toEqual([ third.noteId, first.noteId, second.noteId ]);

        const res = await undo();
        expect(res.body.success).toBe(true);

        expect(childNoteIds(parent.noteId)).toEqual([ first.noteId, second.noteId, third.noteId ]);
        expect([ first, second, third ].map((n) => branchRow(n.branchId)?.notePosition)).toEqual(originalPositions);
    });

    it("undoes a branch delete, restoring the note at its original position", async () => {
        const parent = await createTextNote(api, { title: "Delete undo parent" });
        const kept = await createTextNote(api, { parentNoteId: parent.noteId, title: "Delete undo kept" });
        const victim = await createTextNote(api, { parentNoteId: parent.noteId, title: "Delete undo victim" });

        const originalPosition = branchRow(victim.branchId)?.notePosition;

        const del = await api.delete(
            `/api/branches/${victim.branchId}?taskId=del-1&last=true&undoGroupId=delete-1`
        );
        expect(del.status).toBe(200);
        expect(noteIsDeleted(victim.noteId)).toBe(1);
        expect(childNoteIds(parent.noteId)).toEqual([ kept.noteId ]);

        const res = await undo();
        expect(res.body.success).toBe(true);

        expect(noteIsDeleted(victim.noteId)).toBe(0);
        expect(childNoteIds(parent.noteId)).toEqual([ kept.noteId, victim.noteId ]);
        expect(branchRow(victim.branchId)?.notePosition).toBe(originalPosition);
    });

    it("undoes deleting one clone's branch without touching the other clone", async () => {
        const parentA = await createTextNote(api, { title: "Clone parent A" });
        const parentB = await createTextNote(api, { title: "Clone parent B" });
        const note = await createTextNote(api, { parentNoteId: parentA.noteId, title: "Cloned note" });

        const clone = await api.put(`/api/notes/${note.noteId}/clone-to-note/${parentB.noteId}`, { body: { prefix: null } });
        expect(clone.status).toBe(200);
        const cloneBranchId = `${parentB.noteId}_${note.noteId}`;
        expect(branchRow(cloneBranchId)?.isDeleted).toBe(0);

        // Deleting one branch of a cloned note keeps the note alive.
        const del = await api.delete<{ noteDeleted: boolean }>(
            `/api/branches/${note.branchId}?taskId=del-2&last=true&undoGroupId=delete-2`
        );
        expect(del.body.noteDeleted).toBe(false);
        expect(noteIsDeleted(note.noteId)).toBe(0);
        expect(childNoteIds(parentA.noteId)).toEqual([]);

        const res = await undo();
        expect(res.body.success).toBe(true);

        expect(childNoteIds(parentA.noteId)).toEqual([ note.noteId ]);
        // The other clone was never touched.
        expect(branchRow(cloneBranchId)?.isDeleted).toBe(0);
        expect(childNoteIds(parentB.noteId)).toEqual([ note.noteId ]);
    });

    it("refuses to undo when the original context is gone and leaves data untouched", async () => {
        const source = await createTextNote(api, { title: "Doomed source" });
        const target = await createTextNote(api, { title: "Doomed target" });
        const child = await createTextNote(api, { parentNoteId: source.noteId, title: "Doomed child" });

        await api.put(`/api/branches/${child.branchId}/move-to/${target.branchId}?undoGroupId=ctx-1`);

        // The target parent is deleted after the move, so the moved note's new home is gone.
        await api.delete(`/api/notes/${target.noteId}`, { query: { taskId: "del-3", last: "true" } });
        expect(noteIsDeleted(child.noteId)).toBe(1);

        const res = await undo();
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBeTruthy();

        // Nothing was partially restored: the original branch stays deleted and the note
        // remains where the subsequent delete left it.
        expect(branchRow(child.branchId)?.isDeleted).toBe(1);
        expect(noteIsDeleted(child.noteId)).toBe(1);
        expect(childNoteIds(source.noteId)).toEqual([]);
    });

    it("keeps only the most recent operation undoable", async () => {
        const parent = await createTextNote(api, { title: "Replace parent" });
        const target = await createTextNote(api, { title: "Replace target" });
        const first = await createTextNote(api, { parentNoteId: parent.noteId, title: "Replace first" });
        const second = await createTextNote(api, { parentNoteId: parent.noteId, title: "Replace second" });

        await api.put(`/api/branches/${first.branchId}/move-to/${target.branchId}?undoGroupId=replace-1`);
        await api.put(`/api/branches/${second.branchId}/move-to/${target.branchId}?undoGroupId=replace-2`);

        // Only the second move is undone.
        const res = await undo();
        expect(res.body.success).toBe(true);
        expect(childNoteIds(parent.noteId)).toEqual([ second.noteId ]);
        expect(childNoteIds(target.noteId)).toEqual([ first.noteId ]);

        // The first operation is no longer undoable.
        const secondUndo = await undo();
        expect(secondUndo.body.success).toBe(false);
        expect(childNoteIds(target.noteId)).toEqual([ first.noteId ]);
    });

    it("does not record operations without an undoGroupId", async () => {
        const target = await createTextNote(api, { title: "Plain target" });
        const child = await createTextNote(api, { title: "Plain child" });

        await api.put(`/api/branches/${child.branchId}/move-to/${target.branchId}`);

        const res = await undo();
        expect(res.body.success).toBe(false);
        expect(childNoteIds(target.noteId)).toEqual([ child.noteId ]);
    });
});
