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
import { TooltipButton } from '../common/TooltipButton';
import { ModalDialog } from '../common/ModalDialog';

export const SavedRoomsSection: React.FC = () => {
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
      showToast('Não foi possível salvar a ordem das salas.');
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
      showToast('Sala removida da lista.');
    } catch { showToast('Não foi possível remover a sala salva.'); }
  };

  return (
    <section className="saved-rooms-section" aria-labelledby="saved-rooms-title">
      <div className="saved-rooms-heading">
        <div>
          <h2 id="saved-rooms-title">Salas salvas</h2>
        </div>
        <button className="btn btn-secondary saved-rooms-add" onClick={() => openModal('saveInvite')}>
          <BookmarkPlus size={16} /> Salvar convite
        </button>
      </div>
      {rooms.length === 0 ? (
        <p className="saved-rooms-empty">Nenhuma sala salva ainda.</p>
      ) : (
        <div className={`saved-rooms-grid ${sortable.draggingId ? 'is-sorting' : ''}`} ref={sortable.gridRef}>
          {orderedRooms.map((room) => (
            <article className={`saved-room-card ${sortable.draggingId === room.roomId ? 'is-dragging' : ''}`}
              data-sortable-id={room.roomId} key={room.roomId} onContextMenu={(event) => openContextMenu(event, [
              { id: 'enter', label: 'Entrar na sala', icon: <ArrowRight size={15} />, onSelect: () => openSaved(room) },
              { id: 'edit', label: 'Editar sala salva', icon: <Pencil size={15} />, onSelect: () => setEditingRoom(room) },
              { id: 'remove', label: 'Remover das salas salvas', icon: <Trash2 size={15} />, danger: true, onSelect: () => setRemovingRoom(room) },
            ])}>
              <div className="saved-room-card-heading">
                <TooltipButton tooltip="Arraste para reordenar ou use as setas do teclado"
                  className="btn saved-room-drag-handle"
                  aria-label={`Reordenar ${room.customName ?? room.name}`}
                  disabled={rooms.length < 2} {...sortable.handleProps(room.roomId)}>
                  <GripVertical size={17} />
                </TooltipButton>
                <div className="saved-room-details">
                  <strong>{room.customName ?? room.name}</strong>
                  <span>{room.owned ? 'Sua sala' : 'Participante'} · {room.roomId.slice(0, 8)}
                    {room.password !== undefined && <LockKeyhole size={12} aria-label="Senha lembrada" />}</span>
                </div>
              </div>
              <div className="saved-room-actions">
                <button className="btn btn-primary btn-sm saved-room-enter" onClick={() => openSaved(room)}>
                  Entrar <ArrowRight size={14} />
                </button>
                <button className="btn btn-outline btn-sm saved-room-icon-button"
                  onClick={() => setEditingRoom(room)} aria-label={`Editar ${room.name}`}>
                  <Pencil size={14} />
                </button>
                <button className="btn btn-outline btn-sm saved-room-remove" onClick={() => setRemovingRoom(room)}
                  aria-label={`Remover ${room.name} das salas salvas`}><Trash2 size={14} /></button>
              </div>
            </article>
          ))}
        </div>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {sortable.draggingId ? `Movendo sala. Posição ${sortable.order.indexOf(sortable.draggingId) + 1} de ${rooms.length}.` : ''}
      </span>
      {editingRoom && <EditSavedRoomDialog room={editingRoom} onClose={() => setEditingRoom(null)} />}
      {removingRoom && <ModalDialog title="Remover sala salva?" icon={<Trash2 size={20} />}
        onClose={() => setRemovingRoom(null)} footer={(close) => <>
          <button type="button" className="btn btn-secondary" data-autofocus onClick={close}>Cancelar</button>
          <button type="button" className="btn btn-danger" onClick={() => {
            void removeSaved(removingRoom);
            close();
          }}>Remover</button>
        </>}>
        <p>Remover “<strong>{removingRoom.customName ?? removingRoom.name}</strong>” das salas salvas?</p>
      </ModalDialog>}
    </section>
  );
};
