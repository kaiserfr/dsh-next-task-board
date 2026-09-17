import type { BoardController } from '../../core/controller.ts';
import { type TaskRecord } from '../../core/tasks.ts';
export interface NewTaskModalProps {
    controller: BoardController;
    onClose: () => void;
    /** Optional task template to clone/duplicate from. */
    initialTask?: TaskRecord;
    /**
     * Workspace the board's project filter has selected (#1536): a task created
     * while a project is open belongs to that project unless the user changes it.
     */
    defaultWorkspaceId?: string;
    /** Optional callback after successful duplication (e.g. to archive source). */
    onDuplicateSuccess?: (sourceTaskId: string) => Promise<void>;
}
/** New-task form overlay. */
export declare function NewTaskModal({ controller, onClose, initialTask, defaultWorkspaceId, onDuplicateSuccess }: NewTaskModalProps): import("react").JSX.Element;
