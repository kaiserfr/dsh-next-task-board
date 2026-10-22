import type { BoardController } from '../../core/controller.ts';
import type { TaskRecord } from '../../core/tasks.ts';
export declare function ReviewSection({ controller, task, timeZone }: {
    controller: BoardController;
    task: TaskRecord;
    timeZone?: string;
}): import("react").JSX.Element | null;
