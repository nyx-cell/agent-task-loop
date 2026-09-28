import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { At } from '@phosphor-icons/react/dist/ssr/At';
import { ArrowUp } from '@phosphor-icons/react/dist/ssr/ArrowUp';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { HardBreak } from '@tiptap/extension-hard-break';
import { History } from '@tiptap/extension-history';
import { Placeholder } from '@tiptap/extension-placeholder';
import { CharacterCount } from '@tiptap/extension-character-count';
import { ROOM_MESSAGE_LIMIT } from '../domain/room-message';
import type { MentionAgent } from './mention-completion';
import { copy } from '../copy';
import { Button } from '~/components/ui/button';
import { docToText, textToDoc, type MentionId } from './composer-doc';
import { MENTION_LIST_ID, mentionOptionId, roomMention } from './composer-mention';



/**
 * The composer is never disabled. A round in progress only changes where a
 * new message lands, and the hint says so. Only the send button waits while
 * the previous message is in flight.
 *
 * The editor is Tiptap, but nothing downstream knows that: `value` in and out
 * is still the plain string the room stores, and a mention is still `@id` by
 * the time it leaves. The document exists so that a mention can be one object
 * you delete in one keystroke instead of nine characters you can half-delete.
 */
export function RoomComposer({ value, sending, agents, onValueChange, onSubmit }: {
  value: string; sending: boolean;
  /** The room's members, in speaking order: who can be mentioned, and in what colour. */
  agents: readonly MentionAgent[];
  onValueChange: (value: string) => void; onSubmit: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeOptionId, setActiveOptionId] = useState<string>();

  // Read by the editor's own handlers, which are created once and must not
  // close over a stale render.
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const menuOpenRef = useRef(false);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  /** The last string this component put on the wire, to break the update loop. */
  const lastTextRef = useRef(value);

  // Keyed by the ids themselves: the crew arrives as a fresh array every render,
  // and rebuilding this list would re-run the effect that sets the document and
  // drop the caret mid-sentence.
  const mentionKey = agents.map(agent => agent.id).join(',');
  const mentionable = useMemo<MentionId[]>(
    () => ['all', ...mentionKey.split(',').filter(Boolean)],
    [mentionKey],
  );

  const setMenu = useCallback((open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpen(open);
  }, []);

  const editor = useEditor({
    // A chat line, not a document: no headings, no lists, no bold.
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      History,
      Placeholder.configure({ placeholder: copy.label.composerPlaceholder }),
      // A ceiling on the document, so a paste cannot grow it without bound. The
      // number the person reads, and the one that gates sending, is the length
      // of the serialised string, because that is what the server measures: a
      // chip is one character here and eight on the wire.
      CharacterCount.configure({ limit: ROOM_MESSAGE_LIMIT }),
      roomMention({
        activeAgentIds: () => agentsRef.current.map(agent => agent.id),
        agents: () => agentsRef.current,
        onOpenChange: setMenu,
        onActiveOptionChange: setActiveOptionId,
      }),
    ],
    content: textToDoc(value, mentionable),
    editorProps: {
      attributes: {
        id: 'room-command',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': copy.label.composer,
        'aria-describedby': 'room-composer-hint',
        class: 'min-h-[78px] max-h-[40dvh] overflow-y-auto font-serif text-base leading-[1.7] text-foreground outline-none',
      },
      handleKeyDown: (view, event) => {
        // An IME is mid-composition, so this key belongs to the candidate
        // window. Enter is swallowed outright: it must not send, must not pick
        // a mention, and must not reach the base keymap and split the
        // paragraph — confirming 中文 is not a newline. Every other key is left
        // to ProseMirror.
        if (view.composing || event.isComposing || event.keyCode === 229) {
          return event.key === 'Enter';
        }
        if (event.key !== 'Enter' || event.shiftKey) return false;
        // The suggestion plugin runs after this handler, so a menu that is open
        // gets Enter handed back to it to pick a member.
        if (menuOpenRef.current) return false;
        event.preventDefault();
        if (event.repeat) return true;
        send();
        return true;
      },
    },
    onUpdate: ({ editor: instance }) => {
      const text = docToText(instance.getJSON());
      lastTextRef.current = text;
      onValueChange(text);
    },
    immediatelyRender: false,
  }, []);

  const characters = value.length;
  const canSend = !sending && !!value.trim() && characters <= ROOM_MESSAGE_LIMIT;
  const canSendRef = useRef(canSend);
  canSendRef.current = canSend;

  function send() {
    if (!canSendRef.current) return;
    submitRef.current();
  }

  // The value can change from outside: a send clears it, a failed send puts the
  // draft back. Rebuild only when the string really differs from what the
  // document already says, or every keystroke would round-trip through
  // setContent and drop the cursor.
  useEffect(() => {
    if (!editor || value === lastTextRef.current) return;
    lastTextRef.current = value;
    editor.commands.setContent(textToDoc(value, mentionable), { emitUpdate: false });
  }, [editor, value, mentionable]);

  const openMentions = () => {
    if (!editor) return;
    // A composer that has never been focused has its caret at the very start,
    // so an unfocused click would put the `@` before everything already typed.
    if (!editor.isFocused) editor.commands.focus('end');
    const { state } = editor;
    const before = state.doc.textBetween(Math.max(0, state.selection.from - 1), state.selection.from);
    // `@` only triggers the suggestion at a word boundary, so give it one.
    const prefix = before && !/\s/.test(before) ? ' @' : '@';
    editor.chain().focus().insertContent(prefix).run();
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  return (
    <form
      className="mx-7 mt-3 mb-[22px] flex shrink-0 flex-col rounded-xl border border-input bg-card px-3.5 pt-3.5 pb-2.5 shadow-card transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15"
      onSubmit={submit}
    >
      {/* The card is the field: the editor gives up its own border and fill so
          focus lands on the whole raised block. */}
      <EditorContent
        editor={editor}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? MENTION_LIST_ID : undefined}
        aria-activedescendant={menuOpen && activeOptionId ? mentionOptionId(activeOptionId) : undefined}
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1.5 border-t border-border pt-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copy.action.mention}
          className="text-muted-foreground hover:text-foreground"
          onMouseDown={event => event.preventDefault()}
          onClick={openMentions}
        >
          <At size={16} />
        </Button>
        <span id="room-composer-hint" className="ml-1 text-xs leading-tight text-muted-foreground">
          {copy.say.composerHint}
        </span>
        {characters > 0 && (
          <span className={`ml-auto text-xs tabular-nums ${characters > ROOM_MESSAGE_LIMIT ? 'text-destructive' : 'text-muted-foreground'}`}>
            {characters} / {ROOM_MESSAGE_LIMIT}
          </span>
        )}
        <Button
          type="submit"
          size="icon"
          className={`size-8 rounded-full ${characters > 0 ? 'ml-2' : 'ml-auto'}`}
          disabled={!canSend}
          aria-label={sending ? copy.action.sending : copy.action.send}
        >
          <ArrowUp size={16} weight="bold" />
        </Button>
      </div>
    </form>
  );
}

export type { Editor };
