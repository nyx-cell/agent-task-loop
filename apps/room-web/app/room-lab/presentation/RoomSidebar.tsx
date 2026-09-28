import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { RoomCatalogItemView } from '../read-model';
import { Wordmark } from './AgentMark';
import { formatAgo } from './format-time';
import { sectionLabel } from './ui';
import { copy } from '../copy';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';

const navLink =
  'flex h-7 items-center justify-between gap-2 rounded-md px-2 text-sm text-sidebar-foreground/75 no-underline transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-foreground';

type ThemeChoice = 'light' | 'dark' | undefined;
const THEME_KEY = 'rivus-theme';
const themeLabels = {
  system: copy.label.themeSystem,
  light: copy.label.themeLight,
  dark: copy.label.themeDark,
} as const;

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

/** shadcn switches on a `dark` class, so 跟随系统 has to resolve the query itself. */
function applyTheme(choice: ThemeChoice) {
  const dark = choice === 'dark'
    || (choice === undefined && window.matchMedia(SYSTEM_DARK).matches);
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * Three states, one text action: follow the system, force light, force dark.
 * The choice is written to the same key the inline script in root.tsx reads
 * before first paint, so a reload does not flash the other theme.
 */
function ThemeAction() {
  const [choice, setChoice] = useState<ThemeChoice>(undefined);
  // Read after mount: the server has no localStorage, and the button's first
  // client render has to match the markup the server sent.
  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') setChoice(stored);
  }, []);
  // While following the system there is no media query doing the work for us:
  // the class has to be restamped whenever the system flips.
  useEffect(() => {
    if (choice !== undefined) return;
    const query = window.matchMedia(SYSTEM_DARK);
    const sync = () => applyTheme(undefined);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [choice]);
  const cycle = () => {
    const next: ThemeChoice = choice === undefined ? 'light' : choice === 'light' ? 'dark' : undefined;
    setChoice(next);
    if (next) window.localStorage.setItem(THEME_KEY, next);
    else window.localStorage.removeItem(THEME_KEY);
    applyTheme(next);
  };
  return (
    <Button variant="ghost" size="xs" onClick={cycle}>
      {copy.label.theme(themeLabels[choice ?? 'system'])}
    </Button>
  );
}

export function RoomSidebar({ rooms, currentRoomId, disabled, onCreate }: {
  rooms: RoomCatalogItemView[];
  currentRoomId: string;
  disabled: boolean;
  onCreate: (title: string) => void;
}) {
  const location = useLocation();
  const onAgents = location.pathname === '/room/agents';
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (creating) inputRef.current?.focus(); }, [creating]);
  const roomCount = rooms.reduce((count, room) => count + 1 + (room.children?.length ?? 0), 0);
  return (
    <nav
      className="flex min-h-0 flex-col gap-[18px] overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground px-2.5 py-3.5 max-[820px]:flex-row max-[820px]:items-center max-[820px]:gap-4 max-[820px]:overflow-x-auto max-[820px]:border-r-0 max-[820px]:border-b max-[820px]:py-2.5"
      aria-label={copy.label.rooms}
    >
      <div className="flex items-center gap-2 px-2 pt-1 max-[820px]:shrink-0 max-[820px]:pt-0">
        <Wordmark taglineClassName="max-[820px]:hidden" />
      </div>

      <div className="flex flex-col gap-0.5 max-[820px]:flex-row max-[820px]:shrink-0" aria-label={copy.label.pages}>
        <Link
          to={`/room/${currentRoomId}`}
          prefetch="intent"
          preventScrollReset
          aria-current={!onAgents ? 'page' : undefined}
          className={navLink}
        >
          {copy.label.rooms}
          <span className="tabular-nums text-xs text-muted-foreground">{roomCount}</span>
        </Link>
        <Link
          to="/room/agents"
          prefetch="intent"
          preventScrollReset
          aria-current={onAgents ? 'page' : undefined}
          className={navLink}
        >
          {copy.label.agents}
        </Link>
      </div>

      <div className="flex min-h-0 flex-col max-[820px]:min-w-0 max-[820px]:flex-1 max-[820px]:flex-row max-[820px]:items-center max-[820px]:gap-2">
        <div className="mb-1 flex h-6 items-center justify-between px-2 max-[820px]:mb-0 max-[820px]:shrink-0 max-[820px]:px-0">
          <h2 className={`${sectionLabel} max-[820px]:hidden`}>{copy.label.rooms}</h2>
          {!creating && (
            <Button variant="ghost" size="xs" disabled={disabled} onClick={() => setCreating(true)}>
              {copy.action.newRoom}
            </Button>
          )}
        </div>
        {creating && (
          <form
            className="shadow-card mb-2 flex flex-col gap-2 rounded-lg border border-input bg-card p-2 max-[820px]:mb-0 max-[820px]:w-[260px] max-[820px]:shrink-0"
            onSubmit={event => {
              event.preventDefault();
              const next = title.trim();
              if (!next) return;
              onCreate(next);
              setTitle('');
              setCreating(false);
            }}
          >
            <label className="sr-only" htmlFor="new-room-title">{copy.label.roomName}</label>
            <Input
              ref={inputRef}
              id="new-room-title"
              value={title}
              maxLength={80}
              placeholder={copy.label.roomNamePlaceholder}
              onChange={event => setTitle(event.currentTarget.value)}
              onKeyDown={event => { if (event.key === 'Escape') { setCreating(false); setTitle(''); } }}
            />
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="xs" onClick={() => { setCreating(false); setTitle(''); }}>{copy.action.cancel}</Button>
              <Button type="submit" size="xs" className="px-2.5" disabled={!title.trim() || disabled}>{copy.action.create}</Button>
            </div>
          </form>
        )}
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 max-[820px]:flex-row max-[820px]:gap-1">
          {rooms.map(room => (
            <li key={room.id} className="max-[820px]:shrink-0">
              <RoomSidebarLink room={room} currentRoomId={currentRoomId} />
              {room.children && room.children.length > 0 && (
                // A private room shows under the room it was opened from, titled
                // by its two members; the person can open and read it like any
                // other room.
                <ul className="m-0 mt-0.5 list-none border-l border-sidebar-border pl-2 max-[820px]:pl-0">
                  {room.children.map(child => (
                    <li key={child.id} className="max-[820px]:shrink-0">
                      <RoomSidebarLink room={child} currentRoomId={currentRoomId} privateRoom />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      <footer className="mt-auto flex flex-col items-start gap-0.5 px-0.5 pt-2 text-xs leading-snug text-muted-foreground max-[820px]:hidden">
        <ThemeAction />
        <span className="px-1.5">{copy.say.savedLocally}</span>
      </footer>
    </nav>
  );
}

/** One room row: its title, how many sit in it, and when it last moved. */
function RoomSidebarLink({ room, currentRoomId, privateRoom }: {
  room: RoomCatalogItemView;
  currentRoomId: string;
  /** A room nested under its parent reads a touch quieter than the room itself. */
  privateRoom?: boolean;
}) {
  return (
    <Link
      to={`/room/${room.id}`}
      prefetch="intent"
      preventScrollReset
      aria-current={room.id === currentRoomId ? 'page' : undefined}
      className="block rounded-md px-2 py-1.5 text-sidebar-foreground/75 no-underline transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-foreground max-[820px]:whitespace-nowrap"
    >
      <span className={`${privateRoom ? 'text-[13px]' : 'text-sm'} block leading-snug [overflow-wrap:anywhere] max-[820px]:inline`}>
        {room.title}
      </span>
      {/* Relative time is read off the clock at render; the server and the
          browser render seconds apart, so the two strings may differ. */}
      <span className="mt-0.5 block text-xs leading-tight text-muted-foreground max-[820px]:hidden" suppressHydrationWarning>
        {copy.label.memberCount(room.memberCount)} · {formatAgo(room.updatedAt)}
      </span>
    </Link>
  );
}
