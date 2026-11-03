import type { BoardController } from '../../core/controller.ts';
import { type TaskRecord } from '../../core/tasks.ts';
export interface NewTaskModalProps {
    controller: BoardController;
    onClose: () => void;
    /** Optional task template to clone/duplicate from. */
    initialTask?: TaskRecord;
    /**
     * Source card of a follow-up: the form is prefilled from it like a duplicate,
     * but the new card stays linked to the source (and the source card stays in
     * place) and continues its conversation on the first run. The Host resolves
     * the source again from its own ledger; this is only the id it names.
     */
    followUpSource?: TaskRecord;
    /**
     * Workspace the board's project filter has selected (#1536): a task created
     * while a project is open belongs to that project unless the user changes it.
     */
    defaultWorkspaceId?: string;
    /** Optional callback after successful duplication (e.g. to archive source). */
    onDuplicateSuccess?: (sourceTaskId: string) => Promise<void>;
}
/** New-task form overlay. */
export declare function NewTaskModal({ controller, onClose, initialTask, followUpSource, defaultWorkspaceId, onDuplicateSuccess }: NewTaskModalProps): import("react").JSX.Element;
