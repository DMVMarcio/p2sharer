import React, { useEffect, useState } from 'react';
import { ArrowRight, BookmarkPlus, LockKeyhole, Pencil, Trash2 } from 'lucide-react';
import { savedRooms, type SavedRoom } from '../../core/saved_rooms';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { roomService } from '../../services/room_service';
import { EditSavedRoomDialog } from '../modals/EditSavedRoomDialog';

export const SavedRoomsSection: React.FC = () => {
  const [rooms, setRooms] = useState<SavedRoom[]>([]);
  const [editingRoom, setEditingRoom] = useState<SavedRoom | null>(null);
  const { openModal } = useModal();
  const { joinRoom, username } = useRoom();

  useEffect(() => {
    const reload = () => {
      void savedRooms.list().then((records) => setRooms(records.filter((room) => room.saved)
        .sort((a, b) => a.name.localeCompare(b.name))))
        .catch((error) => console.warn('[Rooms] Could not load saved rooms:', error));
    };
    reload();
    return savedRooms.subscribe(reload);
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
        <button className="btn btn-secondary" onClick={() => {
          roomService.pendingJoinInvite = '';
          roomService.pendingJoinAsOwner = false;
          openModal('joinRoom');
        }}>
          <BookmarkPlus size={16} /> Salvar convite
        </button>
      </div>
      {rooms.length === 0 ? (
        <p className="saved-rooms-empty">Nenhuma sala salva ainda.</p>
      ) : (
        <div className="saved-rooms-list">
          {rooms.map((room) => (
            <div className="saved-room-row" key={room.roomId}>
              <div className="saved-room-details">
                <strong>{room.name}</strong>
                <span>{room.owned ? 'Sua sala' : 'Participante'} · {room.roomId.slice(0, 8)}
                  {room.password !== undefined && <LockKeyhole size={12} aria-label="Senha lembrada" />}</span>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => openSaved(room)}>
                Entrar <ArrowRight size={14} />
              </button>
              <button className="btn btn-outline btn-sm saved-room-icon-button"
                onClick={() => setEditingRoom(room)} aria-label={`Editar ${room.name}`}>
                <Pencil size={14} />
              </button>
              <button className="btn btn-outline btn-sm saved-room-remove" onClick={() => void removeSaved(room)}
                aria-label={`Remover ${room.name} das salas salvas`}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {editingRoom && <EditSavedRoomDialog room={editingRoom} onClose={() => setEditingRoom(null)} />}
    </section>
  );
};
