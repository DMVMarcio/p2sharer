import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useState } from 'react';
import { ArrowRight, BookmarkPlus, GripVertical, LockKeyhole, Pencil, Trash2 } from 'lucide-react';
import { savedRooms, type SavedRoom } from '../../core/saved_rooms';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { roomService } from '../../services/room_service';
import { useContextMenu } from '../common/ContextMenu';
import { EditSavedRoomDialog } from '../modals/EditSavedRoomDialog';
import { orderSavedRooms } from '../../core/saved_room_order';
import { useSortableGrid } from '../../hooks/useSortableGrid';
import { ModalDialog } from '../common/ModalDialog';

export const SavedRoomsSection: React.FC = () => {
  useLocale();
  const openContextMenu = useContextMenu();
  const [rooms, setRooms] = useState<SavedRoom[]>([]);
  const [editingRoom, setEditingRoom] = useState<SavedRoom | null>(null);
  const [removingRoom, setRemovingRoom] = useState<SavedRoom | null>(null);
  const { openModal } = useModal();
  const { joinRoom, username } = useRoom();
  const sortable = useSortableGrid(rooms.map((room) => room.roomId), (ids) => {
    try {
      savedRooms.reorder(ids);
      setRooms((records) => orderSavedRooms(records, ids));
      return true;
    } catch {
      showToast(t("message.128c78d2ee24"));
      return false;
    }
  });
  const orderedRooms = sortable.order.map((id) => rooms.find((room) => room.roomId === id))
    .filter((room): room is SavedRoom => !!room);
  // Include newly loaded records before the hook reconciles its draft in the layout effect.
  orderedRooms.push(...rooms.filter((room) => !sortable.order.includes(room.roomId)));

  useEffect(() => {
    let generation = 0;
    let disposed = false;
    const reload = () => {
      const current = ++generation;
      void savedRooms.list().then((records) => {
        if (!disposed && current === generation) setRooms(orderSavedRooms(records.filter((room) => room.saved)));
      })
        .catch((error) => console.warn('[Rooms] Could not load saved rooms:', error));
    };
    reload();
    const unsubscribe = savedRooms.subscribe(reload);
    return () => { disposed = true; unsubscribe(); };
  }, []);

  const openSaved = (room: SavedRoom) => {
    if (!username) { openModal('username'); return; }
    if (room.protected !== false && room.password === undefined) {
      roomService.pendingJoinInvite = room.invite;
      roomService.pendingJoinAsOwner = room.owned;
      openModal('joinRoom');
      return;
    }
    joinRoom(room.invite, room.password ?? '', room.owned);
  };

  const removeSaved = async (room: SavedRoom) => {
    try {
      await savedRooms.put({ ...room, saved: false, password: undefined });
      showToast(t("message.8f1e60abcf3e"));
    } catch { showToast(t("message.bef29a92c3b0")); }
  };

  return (
    <section className="saved-rooms-section" aria-labelledby="saved-rooms-title">
      <div className="saved-rooms-heading">
        <div>
          <h2 id="saved-rooms-title">{t("message.61aef6ed3afc")}</h2>
        </div>
        <button className="btn btn-secondary saved-rooms-add" onClick={() => openModal('saveInvite')}>
          <BookmarkPlus size={16} /> {t("message.2e84ec959672")}</button>
      </div>
      {rooms.length === 0 ? (
        <p className="saved-rooms-empty">{t("message.aa2f2b18a6b1")}</p>
      ) : (
        <div className={`saved-rooms-grid ${sortable.draggingId ? 'is-sorting' : ''}`} ref={sortable.gridRef}>
          {orderedRooms.map((room) => (
            <article className={`saved-room-card ${sortable.draggingId === room.roomId ? 'is-dragging' : ''}`}
              data-sortable-id={room.roomId} key={room.roomId} ref={sortable.cardRef(room.roomId)} onContextMenu={(event) => openContextMenu(event, [
              { id: 'enter', get label() { return t("message.f1388bfdc0f9"); }, icon: <ArrowRight size={15} />, onSelect: () => openSaved(room) },
              { id: 'edit', get label() { return t("message.4c6b05644363"); }, icon: <Pencil size={15} />, onSelect: () => setEditingRoom(room) },
              { id: 'remove', get label() { return t("message.10cc035e54a6"); }, icon: <Trash2 size={15} />, danger: true, onSelect: () => setRemovingRoom(room) },
            ])}>
              <div className="saved-room-card-heading">
                <button type="button"
                  className="btn saved-room-drag-handle"
                  aria-label={t("message.3427432bc05d", { v0: room.customName ?? room.name })}
                  disabled={rooms.length < 2} {...sortable.handleProps(room.roomId)}>
                  <GripVertical size={17} />
                </button>
                <div className="saved-room-details">
                  <strong>{room.customName ?? room.name}</strong>
                  <span>{room.owned ? t("message.66abaa8c669e") : t("message.1e97ddf60a0f")} · {room.roomId.slice(0, 8)}
                    {room.password !== undefined && <LockKeyhole size={12} aria-label={t("message.3ef5534f852c")} />}</span>
                </div>
              </div>
              <div className="saved-room-actions">
                <button className="btn btn-primary btn-sm saved-room-enter" onClick={() => openSaved(room)}>
                  {t("message.4105811890ae")}<ArrowRight size={14} />
                </button>
                <button className="btn btn-outline btn-sm saved-room-icon-button"
                  onClick={() => setEditingRoom(room)} aria-label={t("message.c0a6f99cb765", { v0: room.name })}>
                  <Pencil size={14} />
                </button>
                <button className="btn btn-outline btn-sm saved-room-remove" onClick={() => setRemovingRoom(room)}
                  aria-label={t("message.4814bd50cf7c", { v0: room.name })}><Trash2 size={14} /></button>
              </div>
            </article>
          ))}
        </div>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {sortable.draggingId ? t("message.1ab84eb11262", { v0: sortable.order.indexOf(sortable.draggingId) + 1, v1: rooms.length }) : ''}
      </span>
      {editingRoom && <EditSavedRoomDialog room={editingRoom} onClose={() => setEditingRoom(null)} />}
      {removingRoom && <ModalDialog title={t("message.f9f10a452737")} icon={<Trash2 size={20} />}
        onClose={() => setRemovingRoom(null)} footer={(close) => <>
          <button type="button" className="btn btn-secondary" data-autofocus onClick={close}>{t("message.bb9dbb406dcb")}</button>
          <button type="button" className="btn btn-danger" onClick={() => {
            void removeSaved(removingRoom);
            close();
          }}>{t("message.a3037dc71a43")}</button>
        </>}>
        <p>{t("message.d7d47d0a09e0")}<strong>{removingRoom.customName ?? removingRoom.name}</strong>{t("message.6d8b842e23ea")}</p>
      </ModalDialog>}
    </section>
  );
};
