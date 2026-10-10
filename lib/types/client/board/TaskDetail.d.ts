import type { BoardController } from '../../core/controller.ts';
import { type TaskRecord } from '../../core/tasks.ts';
/** Task detail overlay. */
export declare function TaskDetail({ controller, task, waitingReason }: {
    controller: BoardController;
    task: TaskRecord;
    waitingReason?: string;
}): import("react").JSX.Element;
