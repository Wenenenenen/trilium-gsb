import treeUndoService from "../../services/tree_undo.js";

/**
 * @swagger
 * /api/tree-undo:
 *   post:
 *     summary: Undo the most recent tree structure change
 *     operationId: tree-undo
 *     responses:
 *       '200':
 *         description: Result of the undo attempt
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   description: Why the undo could not be performed, when success is false
 *     security:
 *       - session: []
 *     tags: ["data"]
 */
function undoLastTreeOperation() {
    return treeUndoService.undoLastOperation();
}

export default {
    undoLastTreeOperation
};
