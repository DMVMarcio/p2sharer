import { profileImages } from '../../core/profile_image';
import { Nickname } from '../common/Nickname';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { profileAction } from '../common/profile_actions';
import { modalManager } from '../../hooks/useModal';
import { getLanguage, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useDropdownPresence } from '../../hooks/useDropdownPresence';
import { useRoom } from '../../hooks/useRoom';
import { EmojiPicker } from '../common/EmojiPicker';
import { EmojiPickerPopover } from '../common/EmojiPickerPopover';
import { EmojiComposerInput, type EmojiComposerHandle } from '../common/EmojiComposerInput';
import { ChatMessageContent } from '../common/ChatMessageContent';
import { getEmojiPack, subscribeEmojiPack } from '../../core/emoji_preferences';
import { getTransferSpeedUnit, subscribeTransferSpeedUnit } from '../../core/transfer_speed';
import { SystemNoticeIcon } from './SystemNoticeIcon';
import { SystemNoticeText } from './SystemNoticeText';
import { useEmojiSelectionHighlight } from '../../hooks/useEmojiSelectionHighlight';
import { ChatMessageMenu } from './ChatMessageMenu';
import { isContextMenuEditor, useContextMenu } from '../common/ContextMenu';
import { getChatMessageActions, type ChatMessageActionsProps } from './chat_message_actions';
import { EditedMessageMarker } from './EditedMessageMarker';
import { Paperclip, Reply, Smile, X } from 'lucide-react';
import { useChatFileInput } from '../../hooks/useChatFileInput';
import { ChatFileDropOverlay } from './ChatFileDropOverlay';
import { ChatFileOfferDialog } from './ChatFileOfferDialog';
import { ChatFileAttachment } from './ChatFileAttachment';
import { ChatTransferCenter } from './ChatTransferCenter';
import { selfId } from '@trystero-p2p/core';
import { showToast } from '../../hooks/useToast';
import { copyImageToClipboard } from '../../core/image_clipboard';
import { ChatMentionSuggestions, type MentionCandidate } from './ChatMentionSuggestions';

let lastChatScrollTop: number | null = null;
let lastChatWasAtBottom = true;

export const ChatPane: React.FC = () => {
  useLocale();
  const openContextMenu = useContextMenu();
  useSyncExternalStore(profileImages.subscribe, profileImages.snapshot);
  const { roomSlots, chatMessages, sendChatMessage, editChatMessage, deleteChatMessage, offerFile,
    requestFile, requestFilePreview, cancelFileTransfer, fileProgress,
    localFilePreviews, imagePreviews, savedDownloads, revealSavedFile,
    peers, username, isCreator, isRoomAdmin } = useRoom();
  const [inputText, setInputText] = useState('');
  const [pickerTarget, setPickerTarget] = useState<'compose' | 'edit' | null>(null);
  const composePicker = useDropdownPresence(pickerTarget === 'compose' ? true : null);
  const editPicker = useDropdownPresence(pickerTarget === 'edit' ? true : null);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionRange, setMentionRange] = useState<{ from: number; to: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const emojiPack = useSyncExternalStore(subscribeEmojiPack, getEmojiPack);
  const transferSpeedUnit = useSyncExternalStore(subscribeTransferSpeedUnit, getTransferSpeedUnit);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isInitialMount = useRef(true);
  const inputRef = useRef<EmojiComposerHandle>(null);
  const editRef = useRef<EmojiComposerHandle>(null);
  const editEmojiButtonRef = useRef<HTMLButtonElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const composerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const { selectedFile, dragging, close: closeFile, markOffered, pickFile } = useChatFileInput(paneRef);
  useEmojiSelectionHighlight(paneRef);

  const mentionCandidates = React.useMemo(() => {
    const list: MentionCandidate[] = [];
    const seen = new Set<string>();
    for (const p of (peers ?? [])) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const slot = (roomSlots ?? []).find(s => s.peerId === p.id);
      list.push({
        peerId: p.id,
        name: p.username,
        color: slot?.color ?? profileImages.color(p.id),
        isHost: p.isCreator,
        isAdmin: p.isAdmin && !p.isCreator,
        isLocal: false,
      });
    }
    if (!seen.has(selfId)) {
      list.push({
        peerId: selfId,
        name: username || '',
        color: (roomSlots ?? []).find(s => s.isLocal)?.color ?? profileImages.color('local', true),
        isHost: isCreator,
        isAdmin: isRoomAdmin && !isCreator,
        isLocal: true,
      });
    }
    return list;
  }, [peers, roomSlots, username, isCreator, isRoomAdmin]);

  const filteredMentionCandidates = React.useMemo(() => {
    if (mentionQuery === null || mentionDismissed) return [];
    const q = mentionQuery.toLowerCase();
    if (!q) return mentionCandidates;
    return mentionCandidates
      .filter(c => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q);
        const bStarts = b.name.toLowerCase().startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [mentionCandidates, mentionQuery, mentionDismissed]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  const handleMentionSelect = React.useCallback((candidate: MentionCandidate) => {
    if (!mentionRange) return;
    inputRef.current?.replaceRange(mentionRange, `@${candidate.name} `);
    setMentionQuery(null);
    setMentionRange(null);
    setMentionDismissed(false);
  }, [mentionRange]);

  const handleMentionKeyDown = React.useCallback((key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'): boolean => {
    if (filteredMentionCandidates.length === 0) return false;
    if (key === 'ArrowDown') {
      setMentionIndex(i => (i + 1) % filteredMentionCandidates.length);
      return true;
    }
    if (key === 'ArrowUp') {
      setMentionIndex(i => (i - 1 + filteredMentionCandidates.length) % filteredMentionCandidates.length);
      return true;
    }
    if (key === 'Enter' || key === 'Tab') {
      const candidate = filteredMentionCandidates[mentionIndex];
      if (candidate) {
        handleMentionSelect(candidate);
        return true;
      }
    }
    if (key === 'Escape') {
      setMentionDismissed(true);
      return true;
    }
    return false;
  }, [filteredMentionCandidates, mentionIndex, handleMentionSelect]);

  const visibleMessages = chatMessages.filter((message) => !message.deletedAt);
  const latestMessageId = chatMessages[chatMessages.length - 1]?.id;
  const replyMessage = chatMessages.find((message) => message.id === replyToId && !message.deletedAt);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (lastChatScrollTop !== null && !lastChatWasAtBottom) {
      container.scrollTop = lastChatScrollTop;
    } else {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  const handleMessagesScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    lastChatScrollTop = el.scrollTop;
    lastChatWasAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
  };

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latestMessageId]);

  const jumpToMessage = (id: string) => {
    const target = messageRefs.current.get(id);
    if (!target) { showToast(t("message.9065177c7d89")); return; }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(id);
    window.setTimeout(() => setHighlightedId((current) => current === id ? null : current), 1800);
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setMentionDismissed(true);
      }
      if (!pickerTarget) return;
      if (!composerRef.current?.contains(event.target as Node) &&
          !(event.target as Element).closest('.emoji-picker-popover') &&
          !(event.target as Element).closest('.chat-msg-edit-emoji')) setPickerTarget(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerTarget(null);
        setMentionDismissed(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerTarget]);

  const insertEmoji = (emoji: string) => {
    (pickerTarget === 'edit' ? editRef : inputRef).current?.insertEmoji(emoji);
  };

  const sendMessage = () => {
    const composer = inputRef.current;
    if (!composer?.hasText()) return;
    sendChatMessage(composer.getMarkdown(), replyMessage?.id);
    setInputText('');
    setReplyToId(null);
    setPickerTarget(null);
    setMentionQuery(null);
    setMentionRange(null);
    setMentionDismissed(false);
  };

  const saveEdit = async (id: string) => {
    const content = editRef.current?.getMarkdown() ?? editDraft;
    if (!content.trim()) { showToast(t("message.31233377e60e")); return; }
    if (!await editChatMessage(id, content)) { showToast(t("message.c3ad01e4bc4e"), 3500, 'error'); return; }
    setEditingId(null);
    setPickerTarget(null);
  };

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => showToast(t("message.6f569a9bd431"), 3500, 'success'))
      .catch(() => showToast(t("message.c871a73a0bce"), 3500, 'error'));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };

  const startDownload = (messageId: string, saveAs: boolean) => {
    void requestFile(messageId, saveAs).catch((error) => {
      console.warn('[Files] Could not save download:', error);
      showToast(t("message.fa6c1d18a7c8"), 3500, 'error');
    });
  };
  const revealDownload = (messageId: string, requestId: string) => {
    void revealSavedFile(messageId, requestId).catch(() => showToast(t("message.bf86d73f16f0")));
  };

  return (
    <div className="sidebar-tab-content active" id="tab-content-chat" ref={paneRef}>
      {dragging && <ChatFileDropOverlay />}
      <div
        className="chat-messages-container"
        id="chat-messages-container"
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
      >
        {visibleMessages.map((msg, index) => {
          const timeStr = new Date(msg.timestamp).toLocaleTimeString(getLanguage(), {
            hour: '2-digit',
            minute: '2-digit',
          });
          const repliedMessage = msg.replyTo ? chatMessages.find((item) => item.id === msg.replyTo?.id) : undefined;

          if (msg.isSystem || msg.sender === 'Sistema') {
            const systemType = msg.systemType || 'generic';
            return (
              <div
                key={msg.id || index}
                className={`chat-system-msg chat-system-${systemType}`}
                data-system-type={systemType}
              >
                <div className="chat-system-content">
                  <SystemNoticeIcon type={systemType} />
                  <span className="chat-sys-text"><SystemNoticeText message={msg} /></span>
                  <time className="chat-sys-time" dateTime={new Date(msg.timestamp).toISOString()}>{timeStr}</time>
                </div>
              </div>
            );
          }

          const fileTransfer = msg.file ? Object.values(fileProgress).find((t) => t.messageId === msg.id && t.preview) : undefined;
          const imagePreview = msg.file?.isImage ? (localFilePreviews[msg.id] ?? imagePreviews[msg.id] ?? fileTransfer?.preview) : undefined;

          const authorSlot = roomSlots.find(slot => (slot.ownerPeerId ?? slot.peerId) === msg.authorId || (msg.authorId === selfId && slot.isLocal));
          const messageActions: ChatMessageActionsProps = {
            own: msg.authorId === selfId,
            onReply: () => { setReplyToId(msg.id); inputRef.current?.focus(); },
            onCopy: () => { copyText(msg.text); },
            onCopyImage: imagePreview ? () => { void copyImageToClipboard(imagePreview); } : undefined,
            onEdit: () => { setEditingId(msg.id); setEditDraft(msg.text); setPickerTarget(null); },
            onDelete: () => { void deleteChatMessage(msg.id).then((deleted) => { if (!deleted) showToast(t("message.18d60be566e6"), 3500, 'error'); }); if (editingId === msg.id) setEditingId(null); setPickerTarget(null); },
            isFile: Boolean(msg.file),
            onSaveAs: () => { startDownload(msg.id, true); }
          };

          return (
            <div key={msg.id || index} onContextMenu={event => { if (!isContextMenuEditor(event.target)) openContextMenu(event, getChatMessageActions(messageActions)); }} className={`chat-msg ${highlightedId === msg.id ? 'chat-msg-highlighted' : ''}`} ref={(element) => { if (element) messageRefs.current.set(msg.id, element); else messageRefs.current.delete(msg.id); }}>
              <div className="chat-msg-header" onContextMenu={event => {
                if (!(event.target instanceof Element) || !event.target.closest('.profile-identity-button')) return;
                event.stopPropagation();
                openContextMenu(event, [profileAction({ peerId: msg.authorId ?? '', name: msg.sender,
                  isLocal: msg.authorId === selfId, color: authorSlot?.color ?? profileImages.color(msg.authorId ?? '', msg.authorId === selfId) })]);
              }}>
                <button type="button" className="profile-identity-button" aria-label={t('profile.viewName', { name: msg.sender })}
                  onClick={() => modalManager.openProfile({ peerId: msg.authorId ?? '', name: msg.sender, isLocal: msg.authorId === selfId, color: authorSlot?.color ?? profileImages.color(msg.authorId ?? '', msg.authorId === selfId) })}>
                  <ProfileAvatar peerId={msg.authorId ?? ''} name={msg.sender} isLocal={msg.authorId === selfId}
                    color={authorSlot?.color ?? profileImages.color(msg.authorId ?? '', msg.authorId === selfId)} className="chat-msg-avatar" />
                  <span className="chat-msg-sender"><Nickname name={msg.sender} peerId={msg.authorId} isLocal={msg.authorId === selfId} defaultColor={profileImages.background(msg.authorId ?? '', msg.authorId === selfId, authorSlot?.color)} /></span>
                </button>
                {msg.isHost && <span className="badge-host">{t("common.hostBadge")}</span>}
                {msg.editedAt && <EditedMessageMarker editedAt={msg.editedAt} />}
                <span className="chat-msg-time">{timeStr}</span>
                <ChatMessageMenu {...messageActions} />
              </div>
              <div className={`chat-msg-bubble${msg.file ? '' : ' chat-msg-text'}`}>
                {msg.replyTo && !repliedMessage?.deletedAt && <button type="button" className="chat-msg-reply" onClick={() => jumpToMessage(msg.replyTo!.id)}>
                  <span>{msg.replyTo.sender}</span>
                  <span>{repliedMessage?.text ?? msg.replyTo.text}</span>
                </button>}
                {editingId === msg.id ? <div className="chat-msg-edit">
                  <EmojiComposerInput id={`chat-edit-${msg.id}`} ref={editRef} value={editDraft} pack={emojiPack} onChange={setEditDraft} onSend={() => saveEdit(msg.id)} />
                  <div className="chat-msg-edit-actions">
                    <button ref={editEmojiButtonRef} type="button" className={`chat-msg-edit-emoji ${pickerTarget === 'edit' ? 'active' : ''}`} aria-label={t("message.393abe74ad54")} aria-expanded={pickerTarget === 'edit'} onClick={() => setPickerTarget((current) => current === 'edit' ? null : 'edit')}><Smile size={15} /></button>
                    <button type="button" onClick={() => { setEditingId(null); setPickerTarget(null); }}>{t("message.bb9dbb406dcb")}</button>
                    <button type="button" onClick={() => saveEdit(msg.id)}>{t("message.aef7cd5b2081")}</button>
                  </div>
                </div> : msg.file ? <ChatFileAttachment message={msg}
                  speedUnit={transferSpeedUnit}
                  transfers={Object.values(fileProgress).filter((transfer) => transfer.messageId === msg.id)}
                  preview={localFilePreviews[msg.id] ?? imagePreviews[msg.id]}
                  savedRequestId={savedDownloads[msg.id]}
                  onRequest={(saveAs) => startDownload(msg.id, saveAs)}
                  onPreview={() => void requestFilePreview(msg.id).catch(() => showToast(t("message.c843237cc8ed")))}
                  onCancel={(id) => void cancelFileTransfer(id)}
                  onReveal={(id) => revealDownload(msg.id, id)} /> : <ChatMessageContent text={msg.text} pack={emojiPack} />}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-composer" ref={composerRef}>
      {filteredMentionCandidates.length > 0 && !mentionDismissed && (
        <ChatMentionSuggestions
          candidates={filteredMentionCandidates}
          selectedIndex={mentionIndex}
          onSelect={handleMentionSelect}
        />
      )}
      {composePicker.value && <EmojiPicker pack={emojiPack} onSelect={insertEmoji} closing={composePicker.closing} />}
      {replyMessage && <div className="chat-composer-reply">
        <Reply size={15} />
        <div><strong>{t("message.7f5995965115")} {replyMessage.sender}</strong><span>{replyMessage.text}</span></div>
        <button type="button" aria-label={t("message.c0ec9adf7f1d")} onClick={() => setReplyToId(null)}><X size={16} /></button>
      </div>}
      <form autoComplete="off" className="chat-input-bar" id="chat-input-form" onSubmit={handleSubmit}>
        <EmojiComposerInput
          ref={inputRef}
          value={inputText}
          pack={emojiPack}
          onChange={setInputText}
          onSend={sendMessage}
          mentionActive={filteredMentionCandidates.length > 0 && !mentionDismissed}
          onMentionQueryChange={(query, range) => {
            setMentionQuery(query);
            setMentionRange(range);
            if (query !== null) setMentionDismissed(false);
          }}
          onMentionKeyDown={handleMentionKeyDown}
        />
        <div className="chat-input-actions">
          <div className="chat-input-actions-left">
            <button type="button" className={`btn-chat-emoji ${pickerTarget === 'compose' ? 'active' : ''}`}
              aria-label={t("message.393abe74ad54")} aria-expanded={pickerTarget === 'compose'}
              onClick={() => setPickerTarget((current) => current === 'compose' ? null : 'compose')}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01" strokeWidth="2.5"/>
              </svg>
            </button>
            <button type="button" className="btn-chat-emoji" aria-label={t("message.0176661d7e81")} onClick={() => void pickFile()}><Paperclip size={18} /></button>
          </div>
          <ChatTransferCenter />
          <button type="submit" className="btn-chat-send" aria-label={t("message.c45497103c0e")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" x2="11" y1="2" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </form>
      </div>
      {editPicker.value && <EmojiPickerPopover anchor={editEmojiButtonRef.current} pack={emojiPack} onSelect={insertEmoji} closing={editPicker.closing} />}
      {selectedFile && <ChatFileOfferDialog key={selectedFile.id} file={selectedFile} onClose={closeFile} onOffer={async (name, autoAccept) => { await offerFile(selectedFile, name, autoAccept); markOffered(); }} />}
    </div>
  );
};
