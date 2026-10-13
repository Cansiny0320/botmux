import { useEffect, useRef, useState } from 'react';
import type { ChatReplyMode } from '../../bot-registry.js';
import { useT } from './react-hooks.js';

/** daemon `getChatReplyModeState` 的投影（GET /api/groups → memberBots[].replyMode）。 */
export interface GroupReplyModeState {
  override: ChatReplyMode | null;
  default: ChatReplyMode;
  effective: ChatReplyMode;
  inherited: boolean;
}

type Choice = 'inherit' | ChatReplyMode;
const MODES: readonly ChatReplyMode[] = ['chat-topic', 'chat', 'shared', 'new-topic'];

const MODE_LABEL_KEY: Record<ChatReplyMode, string> = {
  'chat-topic': 'groups.replyModeChatTopic',
  chat: 'groups.replyModeChat',
  shared: 'groups.replyModeShared',
  'new-topic': 'groups.replyModeNewTopic',
};

type Props = {
  chatId: string;
  appId: string;
  botName: string;
  state?: GroupReplyModeState;
  /** 话题群（含普通群切成话题布局）：只允许清除休眠覆盖，不能设置新模式。 */
  topicGroup?: boolean;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
};

export function GroupReplyModeRow(props: Props) {
  const tr = useT();
  const toChoice = (s?: GroupReplyModeState): Choice => (s?.override ?? 'inherit');
  const [choice, setChoice] = useState<Choice>(toChoice(props.state));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const savingRef = useRef(false);
  useEffect(() => { if (!savingRef.current) setChoice(toChoice(props.state)); }, [props.state?.override]);

  const modeLabel = (mode: ChatReplyMode) => tr(MODE_LABEL_KEY[mode]);
  const defaultMode = props.state?.default;

  async function save(next: Choice) {
    if (savingRef.current || props.disabled) return;
    const previous = choice;
    setChoice(next);
    savingRef.current = true;
    setSaving(true);
    setStatus(tr('groups.serialInputSaving'));
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/reply-mode/${encodeURIComponent(props.appId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: next }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
      setChoice(body.override ?? 'inherit');
      setStatus(tr('groups.replyModeSaved'));
      try { await props.onSaved(); }
      catch { setStatus(tr('groups.serialInputRefreshFailed')); }
    } catch (error) {
      setChoice(previous);
      const raw = error instanceof Error ? error.message : String(error);
      const known: Record<string, string> = {
        chat_mode_unconfirmed: tr('groups.replyModeChatModeUnconfirmed'),
        regular_group_required: tr('groups.replyModeTopicGroup'),
      };
      setStatus(tr('groups.serialInputFailed', { error: known[raw] ?? raw }));
    } finally { savingRef.current = false; setSaving(false); }
  }

  const source = !props.state
    ? ''
    : props.state.inherited
      ? tr('groups.replyModeSourceInherited', { mode: modeLabel(props.state.effective) })
      : tr('groups.replyModeSourceOverride', { mode: modeLabel(props.state.effective), default: modeLabel(props.state.default) });
  const id = `reply-mode-${props.chatId}-${props.appId}`;
  // 话题群里只保留「继承」和当前（休眠）覆盖值，用来清除；不提供设置新模式。
  const options: Choice[] = props.topicGroup
    ? ['inherit', ...(props.state?.override ? [props.state.override] : [])]
    : ['inherit', ...MODES];
  return <div className="group-reply-mode-row" data-group-reply-mode-row={props.appId}>
    <label htmlFor={id}><strong>{props.botName}</strong></label>
    <select id={id} value={choice} disabled={props.disabled || saving || (props.topicGroup && !props.state?.override)}
      onChange={event => { void save(event.currentTarget.value as Choice); }}>
      {options.map(option => <option key={option} value={option}>
        {option === 'inherit'
          ? tr('groups.replyModeInherit', { mode: defaultMode ? modeLabel(defaultMode) : '-' })
          : modeLabel(option)}
      </option>)}
    </select>
    <small className="group-reply-mode-source">{source}</small>
    <small role="status" aria-live="polite">{status}</small>
  </div>;
}
