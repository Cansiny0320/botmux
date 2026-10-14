import { useEffect, useRef, useState } from 'react';
import type { GroupChat } from './groups-api.js';
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
  // 每次群矩阵重载都会带来新的 state 对象：按对象身份计一个快照修订号，而不是只看
  // override 值是否变化（值相同的新快照也要能被识别）。被取代的重载失败时会回传缓存的
  // 同一个快照对象，不产生新修订号，因此天然不会触发重放。
  const latestStateRef = useRef(props.state);
  latestStateRef.current = props.state;
  const snapshotRevRef = useRef(0);
  useEffect(() => {
    snapshotRevRef.current += 1;
    if (!savingRef.current) setChoice(toChoice(props.state));
  }, [props.state]);

  const modeLabel = (mode: ChatReplyMode) => tr(MODE_LABEL_KEY[mode]);
  const defaultMode = props.state?.default;

  async function save(next: Choice) {
    if (savingRef.current || props.disabled) return;
    const previous = choice;
    const revAtStart = snapshotRevRef.current;
    // PUT 成功确认时的修订号：对象身份不能证明快照比写入新——另一行并发保存触发的
    // 重载可能在本行 PUT 完成前就带回本行的「写入前」值。只有 PUT 完成之后到达的
    // 新修订才可能反映这次写入，才有资格覆盖已确认的保存值。
    let revAtPutConfirmed: number | undefined;
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
      revAtPutConfirmed = snapshotRevRef.current;
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
    } finally {
      // 成功：只有 PUT 确认之后到达的新快照才覆盖保存值（之前到达的可能早于这次写入）。
      // 失败：保存期间到达的任何新快照都比保存前的回滚值新，以最新快照代替回滚值。
      // 保存结束后才到达的快照由上面的 effect（savingRef 已复位）正常应用。
      const baselineRev = revAtPutConfirmed ?? revAtStart;
      if (snapshotRevRef.current !== baselineRev) setChoice(toChoice(latestStateRef.current));
      savingRef.current = false;
      setSaving(false);
    }
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

/** 单群拓扑：'topic' 含「普通群切成话题布局」；'unknown' = 查询失败/未确认（保守处理）。 */
export type GroupTopology = 'loading' | 'group' | 'topic' | 'unknown';

/**
 * 对话框打开时对当前群查一次单群拓扑。列表接口不返回 group_message_type，
 * 普通群切成话题布局只能经单群详情（daemon getChatModeStrict，自带缓存）识别。
 * 建群即话题群（列表 chat_mode=topic）无需再查。每个对话框（chatId）只请求一次。
 */
export function useGroupTopology(chat: GroupChat, probeAppId: string | undefined): GroupTopology {
  const knownTopic = chat.chatMode === 'topic';
  const [topology, setTopology] = useState<GroupTopology>(knownTopic ? 'topic' : probeAppId ? 'loading' : 'unknown');
  const appIdRef = useRef(probeAppId);
  appIdRef.current = probeAppId;
  useEffect(() => {
    if (knownTopic) { setTopology('topic'); return; }
    const appId = appIdRef.current;
    if (!appId) { setTopology('unknown'); return; }
    let alive = true;
    setTopology('loading');
    void (async () => {
      try {
        const response = await fetch(`/api/groups/${encodeURIComponent(chat.chatId)}/chat-mode/${encodeURIComponent(appId)}`);
        const body = await response.json();
        const mode = response.ok && body?.ok === true ? body.chatMode : undefined;
        if (alive) setTopology(mode === 'topic' ? 'topic' : mode === 'group' ? 'group' : 'unknown');
      } catch {
        if (alive) setTopology('unknown');
      }
    })();
    return () => { alive = false; };
  }, [chat.chatId, knownTopic]);
  return topology;
}

/** 「群组 → 管理」里的「普通群回复模式」区块。 */
export function GroupReplyModeSection(props: {
  chat: GroupChat;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
}) {
  const tr = useT();
  const inChat = (props.chat.memberBots ?? []).filter(member => member.inChat);
  const topology = useGroupTopology(props.chat, inChat[0]?.larkAppId);
  const topicGroup = topology === 'topic';
  // 查询中/失败：不预判拓扑、文案中性，保存仍由 daemon strict 闸兜底（话题群 409）。
  const help = topicGroup ? 'groups.replyModeTopicGroupHelp'
    : topology === 'group' ? 'groups.replyModeHelp'
    : 'groups.replyModeNeutralHelp';
  return <fieldset data-group-reply-mode data-topology={topology}>
    <legend>{tr('groups.replyMode')}</legend>
    <p><small>{tr(help)}</small></p>
    {inChat.length === 0 ? <p className="empty">{tr('groups.replyModeNoBots')}</p> : inChat.map(member => <GroupReplyModeRow
      key={`${props.chat.chatId}-${member.larkAppId}`}
      chatId={props.chat.chatId} appId={member.larkAppId}
      botName={member.botName ?? member.larkAppId}
      state={member.replyMode} topicGroup={topicGroup} disabled={props.disabled}
      onSaved={props.onSaved}
    />)}
  </fieldset>;
}
