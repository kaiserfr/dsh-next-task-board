import type { BoardController } from '../../core/controller.ts';
import type { TaskRecord } from '../../core/tasks.ts';
export declare function ReviewSection({ controller, task, pending, timeZone }: {
    controller: BoardController;
    task: TaskRecord;
    /** A controller action for this card is in flight (buttons stay disabled). */
    pending: boolean;
    timeZone?: string;
}): import("react").JSX.Element | null;
