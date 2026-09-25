import React from 'react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';

export const HomeView: React.FC = () => {
  const { openModal } = useModal();
  const { username } = useRoom();

  const handleCreateRoom = () => {
    if (!username) {
      openModal('username');
    } else {
      openModal('createRoom');
    }
  };

  const handleJoinRoom = () => {
    if (!username) {
      openModal('username');
    } else {
      openModal('joinRoom');
    }
  };

  return (
    <section className="view active" id="view-home">
      <div className="hero-container">
        <div className="hero-text">
          <h1 className="hero-title">Salas P2P de Alta Fidelidade</h1>
          <p className="hero-subtitle">
            Transmita tela, janelas e áudio diretamente ponto a ponto sem servidores intermediários.
          </p>
        </div>

        <div className="action-cards-grid">
          {/* Card Create Room */}
          <div className="action-card" id="card-action-host">
            <div className="card-icon-wrapper">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </div>
            <h2 className="card-title">Criar Nova Sala</h2>
            <p className="card-desc">
              Inicie um espaço compartilhado para transmitir sua tela e convidar amigos instantaneamente.
            </p>
            <div className="card-footer">
              <button className="btn btn-primary" id="btn-create-room-direct" onClick={handleCreateRoom}>
                <span>Criar Sala e Entrar</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" x2="19" y1="12" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Card Join Room */}
          <div className="action-card" id="card-action-join">
            <div className="card-icon-wrapper">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                <polyline points="10 17 15 12 10 7"/>
                <line x1="15" x2="3" y1="12" y2="12"/>
              </svg>
            </div>
            <h2 className="card-title">Entrar em uma Sala</h2>
            <p className="card-desc">
              Conecte-se a uma sala existente através do código de compartilhamento.
            </p>
            <div className="card-footer">
              <button className="btn btn-secondary" id="btn-start-join-flow" onClick={handleJoinRoom}>
                <span>Entrar com Código</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" x2="19" y1="12" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
