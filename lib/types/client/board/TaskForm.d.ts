/**
 * Shared task-modal pieces: the overlay shell (backdrop, form, title, error,
 * footer), the title/description/prompt field trio used by both the
 * NewTaskModal and the EditTaskModal, and the "Parse with AI" box both forms
 * offer (same state machine, different opening text). State stays in the
 * owning modal; these are controlled components.
 */
import { type ReactNode } from 'react';
import { type TaskRecord, type TaskTag } from '../../core/tasks.ts';
import type { BoardController } from '../../core/controller.ts';
import type { TaskBoardParseDraft } from '../../protocol.ts';
import { type TaskBoardKey } from '../locales.ts';
/** Modal overlay: closes on backdrop press, submits through the form. */
export declare function ModalShell({ ariaLabel, title, error, pending, submitLabel, onSubmit, onClose, children, }: {
    ariaLabel: string;
    title: string;
    error: string | undefined;
    pending: boolean;
    submitLabel: string;
    onSubmit: () => void;
    onClose: () => void;
    children: ReactNode;
}): import("react").JSX.Element;
/**
 * Opening text of an existing task's "Parse with AI" box: the source text the
 * card was created with, or — when that text is gone (cards from before the
 * box was stored, or a cleared box) — the card's own title, description, and
 * prompt as one editable block. The user can then rewrite that block and run
 * "Parse and fill" again.
 */
export declare function parseSourceText(task: Pick<TaskRecord, 'title' | 'description' | 'prompt' | 'parseText'>): string;
/**
 * State and actions behind one "Parse with AI" box. The owner supplies the
 * opening text and decides what a successful draft does (the create form fills
 * its three fields; the edit form overwrites the task's).
 */
export declare function useAiParse(controller: BoardController, initialText: string, onDraft: (draft: TaskBoardParseDraft) => void): {
    text: string;
    setText: import("react").Dispatch<import("react").SetStateAction<string>>;
    models: readonly import("../../core/controller.ts").ExecutionModelOption[];
    model: string;
    setModel: import("react").Dispatch<import("react").SetStateAction<string>>;
    pending: boolean;
    error: string | undefined;
    setError: import("react").Dispatch<import("react").SetStateAction<string | undefined>>;
    run: () => Promise<void>;
    cancel: () => void;
};
/**
 * The "Parse with AI" box: a source textarea, the route picker, and the
 * run/cancel button. `hintKey` lets the edit form explain that the text is the
 * card's stored source rather than a fresh paste.
 */
export declare function AiParseSection({ parse, hintKey, }: {
    parse: ReturnType<typeof useAiParse>;
    hintKey?: TaskBoardKey;
}): import("react").JSX.Element;
/** Title + description + prompt fields shared by the new and edit task forms. */
export declare function TaskContentFields({ title, description, prompt, onTitleChange, onDescriptionChange, onPromptChange, }: {
    title: string;
    description: string;
    prompt: string;
    /** Receives the new title; the owner also clears its error state. */
    onTitleChange: (value: string) => void;
    onDescriptionChange: (value: string) => void;
    onPromptChange: (value: string) => void;
}): import("react").JSX.Element;
/**
 * Task labels (issue #1521): one row per label holding the badge name and an
 * optional execution hint. The name inputs offer the labels already used on the
 * board through a datalist, and picking one adopts its hint when the row has
 * none — so a business line is defined once and reused by every later task.
 */
export declare function TaskTagFields({ tags, knownTags, onChange, }: {
    tags: TaskTag[];
    /** Labels already carried elsewhere on the board. */
    knownTags: TaskTag[];
    onChange: (tags: TaskTag[]) => void;
}): import("react").JSX.Element;
/**
 * Clean a tag list via normalizeTags: trim, drop blanks and duplicates, cap
 * lengths and count, so the wire always carries a valid tag list.
 */
export declare function cleanTags(tags: readonly TaskTag[]): TaskTag[];
