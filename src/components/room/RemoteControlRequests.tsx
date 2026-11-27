import { useEffect, useState } from 'react';
import { loadRemoteControlHostDefaults } from '../../core/stream/remote_control';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useRoom } from '../../hooks/useRoom';
import {
  RemoteControlPermissionBadges,
  type RemoteControlPermissionKey,
} from '../common/RemoteControlPermissionBadges';

type RequestPermDraft = {
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  gamepadEnabled: boolean;
};

export function RemoteControlToastItems() {
  useLocale();
  const {
    remoteControlRequests,
    remoteControlElevationRequests,
    remoteControlElevationReady,
    peers,
    answerRemoteControlRequest,
    answerRemoteControlElevation,
  } = useRoom();
  const [drafts, setDrafts] = useState<Record<string, RequestPermDraft>>({});
  const [resolvingElevationIds, setResolvingElevationIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const activeIds = new Set(remoteControlRequests.map((req) => req.id));
    setDrafts((prev) => {
      let changed = false;
      const next: Record<string, RequestPermDraft> = {};
      for (const id of Object.keys(prev)) {
        if (activeIds.has(id)) {
          next[id] = prev[id];
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [remoteControlRequests]);

  useEffect(() => {
    const activeIds = new Set(remoteControlElevationRequests.map((req) => req.id));
    setResolvingElevationIds((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const id of Object.keys(prev)) {
        if (activeIds.has(id)) {
          next[id] = prev[id];
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [remoteControlElevationRequests]);

  if (!remoteControlRequests.length && !remoteControlElevationRequests.length) return null;

  const resolveDraft = (requestId: string): RequestPermDraft => {
    const existing = drafts[requestId];
    if (existing) return existing;
    const defaults = loadRemoteControlHostDefaults();
    return {
      mouseEnabled: defaults.defaultMouseEnabled,
      keyboardEnabled: defaults.defaultKeyboardEnabled,
      gamepadEnabled: defaults.defaultGamepadEnabled,
    };
  };

  const togglePerm = (requestId: string, key: RemoteControlPermissionKey, nextVal: boolean) => {
    setDrafts((prev) => {
      const base = prev[requestId] ?? resolveDraft(requestId);
      return {
        ...prev,
        [requestId]: { ...base, [key]: nextVal },
      };
    });
  };

  return (
    <>
      {remoteControlRequests.map((request) => {
        const peerName =
          peers.find((peer) => peer.id === request.peerId)?.username ||
          request.peerId.slice(0, 6);
        const perms = resolveDraft(request.id);
        return (
          <div className="chat-file-toast" key={`rc-${request.id}`}>
            <p className="chat-file-toast-title">
              <strong className="chat-file-toast-person">{peerName}</strong>{' '}
              {t('remoteControl.requestPrompt')}
            </p>
            <span>{t('remoteControl.requestHint')}</span>
            <RemoteControlPermissionBadges
              className="rc-request-toast-perms"
              mouseEnabled={perms.mouseEnabled}
              keyboardEnabled={perms.keyboardEnabled}
              gamepadEnabled={perms.gamepadEnabled}
              subjectName={peerName}
              onToggle={(key, nextVal) => togglePerm(request.id, key, nextVal)}
            />
            <div>
              <button
                type="button"
                onClick={() => answerRemoteControlRequest(request.id, false)}
              >
                {t('remoteControl.decline')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => answerRemoteControlRequest(request.id, true, perms)}
              >
                {t('remoteControl.accept')}
              </button>
            </div>
          </div>
        );
      })}
      {remoteControlElevationRequests.map((request) => {
        const peerName =
          peers.find((peer) => peer.id === request.peerId)?.username ||
          request.peerId.slice(0, 6);
        const busy = Boolean(resolvingElevationIds[request.id]);
        return (
          <div className="chat-file-toast" key={`rc-elev-${request.id}`}>
            <p className="chat-file-toast-title">
              <strong className="chat-file-toast-person">{peerName}</strong>{' '}
              {t('remoteControl.adminRequestPrompt')}
            </p>
            <span>
              {t(
                remoteControlElevationReady
                  ? 'remoteControl.adminRequestHintReady'
                  : 'remoteControl.adminRequestHintUac',
              )}
            </span>
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void answerRemoteControlElevation(request.id, false)}
              >
                {t('remoteControl.decline')}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => {
                  setResolvingElevationIds((prev) => ({ ...prev, [request.id]: true }));
                  void answerRemoteControlElevation(request.id, true).finally(() => {
                    setResolvingElevationIds((prev) => {
                      const next = { ...prev };
                      delete next[request.id];
                      return next;
                    });
                  });
                }}
              >
                {t('remoteControl.accept')}
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
