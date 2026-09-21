import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSql } from "../../services/sql/index";
import treeUndoService from "../../services/tree_undo";
import { createTextNote } from "../../test/api_fixtures";
import { CoreApiTester } from "../../test/api_tester";

/**
 * Drives the tree-undo recording (branch move/delete routes) and the undo endpoint through
 * {@link CoreApiTester}, so the spec runs under both the node and standalone (WASM) suites.
 */
let api: CoreApiTester;

function getChildNoteIds(parentNoteId: string): string[] {
    return getSql().getColumn<string>(
        "SELECT noteId FROM branches WHERE parentNoteId = ? AND isDeleted = 0" +
            " ORDER BY notePosition",
        [ parentNoteId ]
    );
}

async function undo() {
    return await api.post<{ success: boolean; message?: string }>("/api/tree-undo");
}

describe("Tree undo API (core)", () => {
    beforeAll(() => {
        api = CoreApiTester.build();
    });

    beforeEach(() => {
        treeUndoService.clearTreeUndo();
    });

    it("undoes a single branch move to another parent", async () => {
        const parentA = await createTextNote(api, { title: "Undo move A" });
        const parentB = await createTextNote(api, { title: "Undo move B" });
        const child = await createTextNote(api, {
            parentNoteId: parentA.noteId,
            title: "Undo move child"
        });

        const move = await api.put(`/api/branches/${child.branchId}/move-to/${parentB.branchId}`, {
            query: { undoTaskId: "undo-single-move" }
        });
        expect(move.status).toBe(200);
        expect(getChildNoteIds(parentB.noteId)).toEqual([ child.noteId ]);

        const res = await undo();
        expect(res.body.success).toBe(true);
        expect(getChildNoteIds(parentA.noteId)).toEqual([ child.noteId ]);
        expect(getChildNoteIds(parentB.noteId)).toEqual([]);
    });

    it("undoes a multi-branch move restoring the original relative order", async () => {
        const parent = await createTextNote(api, { title: "Undo multi parent" });
        const target = await createTextNote(api, { title: "Undo multi target" });
        const anchor = await createTextNote(api, { parentNoteId: target.noteId, title: "Anchor" });

        const names = [ "x", "m1", "y", "m2", "z" ];
        const children: Record<string, { noteId: string; branchId: string }> = {};
        for (const name of names) {
            children[name] = await createTextNote(api, {
                parentNoteId: parent.noteId,
                title: `Undo multi ${name}`
            });
        }

        // The client moves selected branches one request at a time, sharing one undoTaskId.
        for (const name of [ "m1", "m2" ]) {
            const res = await api.put(
                `/api/branches/${children[name].branchId}/move-before/${anchor.branchId}`,
                { query: { undoTaskId: "undo-multi-move" } }
            );
            expect(res.status).toBe(200);
        }
        expect(getChildNoteIds(target.noteId)).toEqual([
            children.m1.noteId,
            children.m2.noteId,
            anchor.noteId
        ]);

        const res = await undo();
        expect(res.body.success).toBe(true);
        expect(getChildNoteIds(parent.noteId)).toEqual(names.map((name) => children[name].noteId));
        expect(getChildNoteIds(target.noteId)).toEqual([ anchor.noteId ]);
    });

    it("undoes a reorder within the same parent", async () => {
        const parent = await createTextNote(api, { title: "Undo reorder parent" });
        const first = await createTextNote(api, { parentNoteId: parent.noteId, title: "Re one" });
        const second = await createTextNote(api, { parentNoteId: parent.noteId, title: "Re two" });
        const third = await createTextNote(api, { parentNoteId: parent.noteId, title: "Re three" });

        const move = await api.put(
            `/api/branches/${third.branchId}/move-before/${first.branchId}`,
            { query: { undoTaskId: "undo-reorder" } }
        );
        expect(move.status).toBe(200);
        expect(getChildNoteIds(parent.noteId)).toEqual([
            third.noteId,
            first.noteId,
            second.noteId
        ]);

        const res = await undo();
        expect(res.body.success).toBe(true);
        expect(getChildNoteIds(parent.noteId)).toEqual([
            first.noteId,
            second.noteId,
            third.noteId
        ]);
    });

    it("undoes a branch deletion restoring note and position", async () => {
        const parent = await createTextNote(api, { title: "Undo delete parent" });
        const first = await createTextNote(api, { parentNoteId: parent.noteId, title: "Del keep" });
        const deleted = await createTextNote(api, { parentNoteId: parent.noteId, title: "Del me" });
        const third = await createTextNote(api, { parentNoteId: parent.noteId });

        const del = await api.delete(`/api/branches/${deleted.branchId}`, {
            query: { taskId: "undo-delete-branch", eraseNotes: "false", last: "true" }
        });
        expect(del.status).toBe(200);
        expect(getChildNoteIds(parent.noteId)).toEqual([ first.noteId, third.noteId ]);

        const res = await undo();
        expect(res.body.success).toBe(true);
        expect(getChildNoteIds(parent.noteId)).toEqual([
            first.noteId,
            deleted.noteId,
            third.noteId
        ]);

        const note = await api.get(`/api/notes/${deleted.noteId}`);
        expect(note.status).toBe(200);
    });

    it("undoes a note deletion with its subtree", async () => {
        const parent = await createTextNote(api, { title: "Undo note delete parent" });
        const deleted = await createTextNote(api, {
            parentNoteId: parent.noteId,
            title: "Delete note me"
        });
        const grandchild = await createTextNote(api, {
            parentNoteId: deleted.noteId,
            title: "Delete note child"
        });

        const del = await api.delete(`/api/notes/${deleted.noteId}`, {
            query: { taskId: "undo-delete-note", last: "true" }
        });
        expect(del.status).toBe(204);
        expect(getChildNoteIds(parent.noteId)).toEqual([]);

        const res = await undo();
        expect(res.body.success).toBe(true);
        expect(getChildNoteIds(parent.noteId)).toEqual([ deleted.noteId ]);
        expect(getChildNoteIds(deleted.noteId)).toEqual([ grandchild.noteId ]);
    });

    it("undoes deleting one clone of a cloned note without touching the other clone", async () => {
        const parentA = await createTextNote(api, { title: "Undo clone A" });
        const parentB = await createTextNote(api, { title: "Undo clone B" });
        const first = await createTextNote(api, { parentNoteId: parentA.noteId });
        const cloned = await createTextNote(api, {
            parentNoteId: parentA.noteId,
            title: "Cloned note"
        });

        const clone = await api.put(
            `/api/notes/${cloned.noteId}/clone-to-branch/${parentB.branchId}`,
            { body: {} }
        );
        expect(clone.status).toBe(200);
        expect(getChildNoteIds(parentB.noteId)).toEqual([ cloned.noteId ]);

        const del = await api.delete(`/api/branches/${cloned.branchId}`, {
            query: { taskId: "undo-delete-clone", eraseNotes: "false", last: "true" }
        });
        expect(del.status).toBe(200);
        expect(getChildNoteIds(parentA.noteId)).toEqual([ first.noteId ]);
        // The remaining clone keeps the note alive.
        expect(getChildNoteIds(parentB.noteId)).toEqual([ cloned.noteId ]);

        const res = await undo();
        expect(res.body.success).toBe(true);
        expect(getChildNoteIds(parentA.noteId)).toEqual([ first.noteId, cloned.noteId ]);
        expect(getChildNoteIds(parentB.noteId)).toEqual([ cloned.noteId ]);
    });

    it("refuses to undo a move when the original parent was deleted afterwards", async () => {
        const parentA = await createTextNote(api, { title: "Undo unsafe A" });
        const parentB = await createTextNote(api, { title: "Undo unsafe B" });
        const child = await createTextNote(api, {
            parentNoteId: parentA.noteId,
            title: "Unsafe child"
        });

        await api.put(`/api/branches/${child.branchId}/move-to/${parentB.branchId}`, {
            query: { undoTaskId: "undo-unsafe-move" }
        });

        // Erasing is not undoable, so it does not replace the recorded move.
        const del = await api.delete(`/api/branches/${parentA.branchId}`, {
            query: { taskId: "undo-unsafe-erase", eraseNotes: "true", last: "true" }
        });
        expect(del.status).toBe(200);

        const res = await undo();
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBeTruthy();
        // The failed undo leaves the tree untouched.
        expect(getChildNoteIds(parentB.noteId)).toEqual([ child.noteId ]);
    });

    it("refuses to undo a deletion when the parent note was deleted afterwards", async () => {
        const parent = await createTextNote(api, { title: "Undo unsafe delete parent" });
        const child = await createTextNote(api, {
            parentNoteId: parent.noteId,
            title: "Unsafe delete child"
        });

        await api.delete(`/api/branches/${child.branchId}`, {
            query: { taskId: "undo-unsafe-delete", eraseNotes: "false", last: "true" }
        });
        await api.delete(`/api/branches/${parent.branchId}`, {
            query: { taskId: "undo-unsafe-delete-erase", eraseNotes: "true", last: "true" }
        });

        const res = await undo();
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBeTruthy();
        // The child stays deleted; nothing was partially restored.
        const restoredRow = getSql().getRowOrNull(
            "SELECT noteId FROM notes WHERE noteId = ? AND isDeleted = 0",
            [ child.noteId ]
        );
        expect(restoredRow).toBeNull();
    });

    it("keeps only the most recent operation undoable", async () => {
        const parentA = await createTextNote(api, { title: "Undo replace A" });
        const parentB = await createTextNote(api, { title: "Undo replace B" });
        const first = await createTextNote(api, {
            parentNoteId: parentA.noteId,
            title: "Replace first"
        });
        const second = await createTextNote(api, {
            parentNoteId: parentA.noteId,
            title: "Replace second"
        });

        await api.put(`/api/branches/${first.branchId}/move-to/${parentB.branchId}`, {
            query: { undoTaskId: "undo-replace-1" }
        });
        await api.put(`/api/branches/${second.branchId}/move-to/${parentB.branchId}`, {
            query: { undoTaskId: "undo-replace-2" }
        });

        const res = await undo();
        expect(res.body.success).toBe(true);
        // Only the second move is undone; the first one is no longer remembered.
        expect(getChildNoteIds(parentA.noteId)).toEqual([ second.noteId ]);
        expect(getChildNoteIds(parentB.noteId)).toEqual([ first.noteId ]);

        const secondUndo = await undo();
        expect(secondUndo.body.success).toBe(false);
    });

    it("does not record expanding a branch or an erased deletion as undoable", async () => {
        const parent = await createTextNote(api, { title: "Undo non-op parent" });
        const child = await createTextNote(api, {
            parentNoteId: parent.noteId,
            title: "Non-op child"
        });

        const expand = await api.put(`/api/branches/${parent.branchId}/expanded/1`);
        expect(expand.status).toBe(204);

        const res = await undo();
        expect(res.body.success).toBe(false);

        await api.delete(`/api/branches/${child.branchId}`, {
            query: { taskId: "undo-erased-delete", eraseNotes: "true", last: "true" }
        });

        const afterErase = await undo();
        expect(afterErase.body.success).toBe(false);
    });
});
