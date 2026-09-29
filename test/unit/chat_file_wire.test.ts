import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFileBase64, decodeSignedFileChunk, encodeFileBase64, encodeSignedFileChunk,
  hashFileChunk } from '../../src/core/chat_file_wire.ts';
import { CHAT_FILE_CHUNK_BYTES } from '../../src/core/chat_file_limits.ts';
import { selectedIceRoute } from '../../src/core/ice_route.ts';

test('binary file chunk preserves metadata and bytes within the protocol limit', async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(128));
  const header = { requestId: 'request', messageId: 'message', offset: 256,
    hash: await hashFileChunk(bytes), signature: 'a'.repeat(128) };
  const packet = encodeSignedFileChunk(header, bytes);
  const decoded = decodeSignedFileChunk(packet);
  assert.deepEqual(decoded?.header, header);
  assert.deepEqual(decoded?.bytes, bytes);
  packet[0] = 255;
  assert.equal(decodeSignedFileChunk(packet), null);
});

test('a full native chunk survives base64 IPC and binary wire conversion', () => {
  const bytes = new Uint8Array(CHAT_FILE_CHUNK_BYTES);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  assert.deepEqual(decodeFileBase64(encodeFileBase64(bytes)), bytes);
});

test('ICE route uses only the selected candidate pair', () => {
  const reports = [
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'direct' },
    { id: 'direct', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local',
      remoteCandidateId: 'remote', currentRoundTripTime: 0.04 },
    { id: 'relay-pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local',
      remoteCandidateId: 'relay' },
    { id: 'local', type: 'local-candidate', candidateType: 'host' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'srflx' },
    { id: 'relay', type: 'remote-candidate', candidateType: 'relay' },
  ];
  assert.deepEqual(selectedIceRoute(reports), { connectionType: 'P2P Direto', pingMs: 40 });
  reports[0].selectedCandidatePairId = 'relay-pair';
  assert.equal(selectedIceRoute(reports).connectionType, 'TURN Relay');
});
