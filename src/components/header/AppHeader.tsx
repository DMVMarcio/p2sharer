import { DownloadButton } from '../common/DownloadButton';
import { Nickname } from '../common/Nickname';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useState } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { modalManager, useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';
import { BookmarkCheck, BookmarkPlus, Check, ChevronDown, Copy, Link, LockKeyhole, LogOut, Settings2 } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { websiteUrl } from '../../platform/website';
import { webRoomPath } from '../../core/web_room_links';
import logo from '../../assets/logo.png';
import { parseRoomInvite } from '../../core/room_invite';
import { roomInviteLink } from '../../core/room_deep_links';
import { savedRooms, type SavedRoom } from '../../core/saved_rooms';
import { AppUpdateButton } from './AppUpdateButton';
import { useContextMenu } from '../common/ContextMenu';
import { profileAction } from '../common/profile_actions';
import { TooltipButton } from '../common/TooltipButton';
import { useClipboardFeedback } from '../../hooks/useClipboardFeedback';

export const AppHeader: React.FC<{ showUpdate?: boolean; homeScrolled?: boolean; onLeaveRoom: () => void }> = ({ showUpdate = true, homeScrolled = false, onLeaveRoom }) => {
  useLocale();
  const openContextMenu = useContextMenu();
  const { currentRoomCode, currentRoomInvite, currentRoomName, currentRoomPassword, username, isInRoom } = useRoom();
  const { openModal } = useModal();
  const [savedRecord, setSavedRecord] = useState<SavedRoom | null>(null);
  const [savingRoom, setSavingRoom] = useState(false);
  const { copied, copy } = useClipboardFeedback(roomInviteLink(currentRoomInvite) || currentRoomCode);
  const invitation = parseRoomInvite(currentRoomInvite);
  const shortInvite = useClipboardFeedback(invitation?.roomId ?? '');
  const webInvite = useClipboardFeedback(websiteUrl(webRoomPath(invitation?.roomId)));
  const inviteCopied = copied || shortInvite.copied || webInvite.copied;

  useEffect(() => {
    const roomId = parseRoomInvite(currentRoomInvite)?.roomId;
    let active = true;
    const reload = () => {
      if (!roomId) { setSavedRecord(null); return; }
      void savedRooms.get(roomId).then((record) => {
        if (active) setSavedRecord(record ?? null);
      }).catch((error) => console.warn('[Rooms] Could not load room save state:', error));
    };
    reload();
    const unsubscribe = savedRooms.subscribe(reload);
    return () => { active = false; unsubscribe(); };
  }, [currentRoomInvite]);

  const toggleSavedRoom = async () => {
    const roomId = parseRoomInvite(currentRoomInvite)?.roomId;
    if (!roomId || savingRoom) return;
    setSavingRoom(true);
    try {
      const record = await savedRooms.get(roomId);
      if (!record) throw new Error('Room record is missing');
      const saved = !record.saved;
      await savedRooms.put({ ...record, saved, password: saved ? record.password : undefined });
      showToast(saved ? t("message.08064fa0da8c") : t("message.7611fbde28f9"), 3500, 'success');
    } catch (error) {
      console.warn('[Rooms] Could not toggle saved room:', error);
      showToast(t("message.d94a6e24bf10"), 3500, 'error');
    } finally {
      setSavingRoom(false);
    }
  };

  return (
    <header className={`app-header${isInRoom ? ' is-in-room' : homeScrolled ? ' is-home-scrolled' : ''}`} data-tauri-drag-region>
      <div className="header-room-info">
        {isInRoom && (
          <>
            {!isTauri() && <TooltipButton tooltip={t('web.home')} aria-label={t('web.home')}
              className="btn-icon-header header-web-home" onClick={onLeaveRoom}><img src={logo} alt="" /></TooltipButton>}
            <div className="header-room-name">
              <strong id="display-room-code">{currentRoomName || currentRoomCode}</strong>
              {currentRoomPassword && <LockKeyhole size={14} className="room-lock-icon" aria-hidden="true" />}
              {currentRoomInvite && (
                <TooltipButton tooltip={savedRecord?.saved ? t("message.1fd26e5f3f0e") : t("message.3caaf5a72320")}
                  className={`btn-icon-header header-room-save ${savedRecord?.saved ? 'is-saved' : ''}`}
                  onClick={() => void toggleSavedRoom()}
                  aria-label={savedRecord?.saved ? t("message.1fd26e5f3f0e") : t("message.7b07e948b7c7")}
                  aria-pressed={Boolean(savedRecord?.saved)} disabled={savingRoom || !savedRecord}>
                  {savedRecord?.saved ? <BookmarkCheck size={16} aria-hidden="true" /> : <BookmarkPlus size={16} aria-hidden="true" />}
                </TooltipButton>
              )}
            </div>
            <TooltipButton tooltip={t(inviteCopied ? 'header.copied' : 'header.invite')}
              className={`btn btn-secondary btn-sm header-room-action${inviteCopied ? ' is-copied' : ''}`}
              id="header-room-code-pill" aria-haspopup="menu" onClick={event => openContextMenu(event, [
                { id: 'short-invite', label: t('invite.short'), icon: <Copy size={15} />,
                  disabled: !invitation || (invitation.version !== 3 && Boolean(invitation.connection)),
                  tooltip: invitation && invitation.version !== 3 && invitation.connection ? t('invite.shortLan') : t('invite.shortHint'),
                  onSelect: () => shortInvite.copy() },
                { id: 'signed-invite', label: t('invite.signed'), icon: <LockKeyhole size={15} />,
                  onSelect: () => copy() },
                { id: 'web-invite', label: t('invite.webLink'), icon: <Link size={15} />,
                  disabled: !invitation || (invitation.version !== 3 && Boolean(invitation.connection)),
                  tooltip: t('invite.shortHint'), onSelect: () => webInvite.copy() },
              ], { toggle: true })}
              aria-label={inviteCopied ? t('header.copied') : t('header.invite')}>
              <span className="header-invite-icon" key={inviteCopied ? 'copied' : 'invite'}>
                {inviteCopied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              </span>
              <span className="header-invite-label" aria-live="polite">{t(inviteCopied ? 'header.copied' : 'header.invite')}</span>
              <ChevronDown size={13} aria-hidden="true" />
            </TooltipButton>
          </>
        )}

        {showUpdate && <AppUpdateButton />}
      </div>

      <div className="header-user-info">
        {!isTauri() && <DownloadButton compact newTab />}
        <button
          className="user-pill"
          id="user-pill"
          onContextMenu={event => openContextMenu(event, [profileAction({ peerId: 'local', name: username, isLocal: true })])}
          onClick={() => modalManager.openProfile({ peerId: 'local', name: username, isLocal: true })}
          aria-label={t('profile.view')}
        >
          <ProfileAvatar name={username} className="header-profile-avatar" />
          <span id="current-username-display"><Nickname name={username || t("message.f53bbaa05fae")} isLocal /></span>
        </button>

        <TooltipButton tooltip={t("message.76b0fb6ad189")}
          className="btn-icon-header"
          id="btn-open-settings"
          onClick={() => openModal('settings')}
          aria-label={t("message.76b0fb6ad189")}
        >
          <Settings2 size={18} aria-hidden="true" />
        </TooltipButton>
        {isInRoom && (
          <TooltipButton tooltip={t("message.7b7b91d7fe87")}
            className="btn-icon-header header-leave-room" id="btn-leave-room"
            onClick={onLeaveRoom} aria-label={t("message.7b7b91d7fe87")}>
            <LogOut size={18} aria-hidden="true" />
          </TooltipButton>
        )}
      </div>
    </header>
  );
};
