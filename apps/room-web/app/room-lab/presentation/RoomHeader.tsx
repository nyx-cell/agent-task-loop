import { useState } from 'react';
import { DotsThree } from '@phosphor-icons/react/dist/ssr/DotsThree';
import type { RoomLabAction, RoomSettingsView } from '../read-model';
import { copy } from '../copy';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';

type MenuPane = 'actions' | 'settings' | 'confirm-clear';

export function RoomHeader({
  title, goal, memberCount, settings, disabled, onMembers, onManage, onReset, onSettings,
}: {
  title: string; goal?: string; memberCount: number; settings: RoomSettingsView; disabled: boolean;
  onMembers: () => void; onManage: () => void; onReset: () => void;
  onSettings: (change: Extract<RoomLabAction, { action: 'settings' }>) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pane, setPane] = useState<MenuPane>('actions');
  const [wake, setWake] = useState(settings.wake);
  const [serial, setSerial] = useState(settings.serial);
  const [cwd, setCwd] = useState(settings.cwd ?? '');
  const closeMenu = () => {
    setMenuOpen(false);
    setPane('actions');
  };
  // The form reads the room's current settings each time it opens, so an
  // edit from another window is not silently overwritten.
  const syncForm = () => {
    setWake(settings.wake);
    setSerial(settings.serial);
    setCwd(settings.cwd ?? '');
  };
  const save = () => {
    const change: Extract<RoomLabAction, { action: 'settings' }> = { action: 'settings' };
    if (wake !== settings.wake) change.wake = wake;
    if (serial !== settings.serial) change.serial = serial;
    if (cwd.trim() !== (settings.cwd ?? '')) change.cwd = cwd.trim();
    // An untouched form is not an action; sending it would read as an error.
    if (change.wake === undefined && change.serial === undefined && change.cwd === undefined) {
      closeMenu();
      return;
    }
    onSettings(change);
    closeMenu();
  };
  return (
    <header className="flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border px-7 pt-[22px] pb-3.5">
      <div className="min-w-0">
        <h1 id="room-heading" className="m-0 text-2xl font-bold leading-tight tracking-[-0.02em] [overflow-wrap:anywhere]">{title}</h1>
        <p className="mt-1 mb-0 text-sm leading-snug text-foreground/75">
          {copy.label.memberCount(memberCount)}
          {goal ? <> · <span className="[overflow-wrap:anywhere]">{goal}</span></> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* Under 1180 the member list is a drawer that already carries an edit
            control, so one button opens it; above, the column is always visible
            and the button jumps straight into editing. */}
        <Button variant="outline" className="min-[1180px]:hidden" onClick={onMembers}>
          {copy.action.members}
        </Button>
        <Button variant="outline" className="max-[1180px]:hidden" onClick={onManage}>
          {copy.action.manageMembers}
        </Button>
        <DropdownMenu
          open={menuOpen}
          onOpenChange={next => { setMenuOpen(next); if (!next) setPane('actions'); }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={copy.action.roomMenu}>
              <DotsThree size={22} weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          {/* Both secondary steps live inside the menu: a two-word confirmation
              and three settings fields are not decisions that deserve to take
              over the screen. */}
          <DropdownMenuContent align="end" className="w-64">
            {pane === 'actions' && (
              <>
                <DropdownMenuItem onSelect={event => { event.preventDefault(); syncForm(); setPane('settings'); }}>
                  {copy.action.roomSettings}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={event => { event.preventDefault(); setPane('confirm-clear'); }}>
                  {copy.action.clearChat}
                </DropdownMenuItem>
              </>
            )}
            {pane === 'confirm-clear' && (
              <div className="flex flex-col gap-2 p-2 text-[13px]">
                <p className="m-0 leading-snug text-foreground/75">{copy.say.clearConfirm}</p>
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="xs" onClick={() => setPane('actions')}>{copy.action.cancel}</Button>
                  <Button
                    variant="destructive"
                    size="xs"
                    className="px-2.5"
                    onClick={() => { closeMenu(); onReset(); }}
                  >
                    {copy.action.confirmClear}
                  </Button>
                </div>
              </div>
            )}
            {pane === 'settings' && (
              <form
                className="flex flex-col gap-2.5 p-2"
                onSubmit={event => { event.preventDefault(); save(); }}
              >
                <label className="flex flex-col gap-1 text-[13px]">
                  {copy.label.roomWake}
                  <select
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px] outline-none focus-visible:border-ring"
                    value={wake}
                    onChange={event => setWake(event.currentTarget.value === 'addressed' ? 'addressed' : 'broadcast')}
                  >
                    <option value="broadcast">{copy.label.wakeBroadcast}</option>
                    <option value="addressed">{copy.label.wakeAddressed}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={serial}
                    onChange={event => setSerial(event.currentTarget.checked)}
                  />
                  {copy.label.roomSerial}
                </label>
                <label className="flex flex-col gap-1 text-[13px]">
                  {copy.label.roomCwd}
                  <Input value={cwd} maxLength={400} placeholder={copy.label.roomCwdPlaceholder} onChange={event => setCwd(event.currentTarget.value)} />
                </label>
                <div className="flex items-center justify-end gap-1">
                  <Button type="button" variant="ghost" size="xs" onClick={() => setPane('actions')}>{copy.action.cancel}</Button>
                  <Button type="submit" size="xs" className="px-2.5" disabled={disabled}>{copy.action.save}</Button>
                </div>
              </form>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
