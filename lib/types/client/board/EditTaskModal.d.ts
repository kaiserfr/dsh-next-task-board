import type { BoardController } from '../../core/controller.ts';
import { type TaskRecord } from '../../core/tasks.ts';
/** Edit-task form overlay. */
export declare function EditTaskModal({ controller, task, onClose }: {
    controller: BoardController;
    task: TaskRecord;
    onClose: () => void;
}): import("react").JSX.Element;
/** Edit-tags modal: edit labels only, shown for tasks after first execution. */
export declare function EditTagsModal({ controller, task, onClose }: {
    controller: BoardController;
    task: TaskRecord;
    onClose: () => void;
}): import("react").JSX.Element;
