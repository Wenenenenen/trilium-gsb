import treeUndoService from "../../services/tree_undo.js";

/**
 * Reverses the most recent undoable tree-structure operation (branch move/reorder/delete).
 * Runs inside the route's transaction, so the restore is atomic: it either fully completes
 * or leaves the tree untouched.
 */
function undoTreeOperation() {
    return treeUndoService.undoLastTreeOperation();
}

export default {
    undoTreeOperation
};
