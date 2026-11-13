import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useRoom } from '../../hooks/useRoom';
import { roomService } from '../../services/room_service';

export function RemoteControlToastItems() {
  useLocale();
  const { remoteControlRequests, peers, answerRemoteControlRequest } = useRoom();
  if (!remoteControlRequests.length) return null;

  return (
    <>
      {remoteControlRequests.map((request) => {
        const peerName =
          peers.find((peer) => peer.id === request.peerId)?.username ||
          request.peerId.slice(0, 6);
        const capture = roomService.localCaptures.get(request.mediaId);
        const targetLabel = capture?.sourceId
          ? undefined
          : undefined;
        void targetLabel;
        return (
          <div className="chat-file-toast" key={`rc-${request.id}`}>
            <p className="chat-file-toast-title">
              <strong className="chat-file-toast-person">{peerName}</strong>{' '}
              {t('remoteControl.requestPrompt')}
            </p>
            <span>{t('remoteControl.requestHint')}</span>
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
                onClick={() => answerRemoteControlRequest(request.id, true)}
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
