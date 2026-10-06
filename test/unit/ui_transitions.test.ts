import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modalManager } from '../../src/hooks/useModal.ts';

describe('Modal lifecycle', () => {
  it('retains the active modal during exit and clears it after closing', async () => {
    modalManager.open('settings');
    assert.equal(modalManager.getActive(), 'settings');
    assert.equal(modalManager.getIsClosing(), false);

    modalManager.close();
    assert.equal(modalManager.getActive(), 'settings', 'Active modal remains during exit transition');
    assert.equal(modalManager.getIsClosing(), true, 'isClosing flag becomes true immediately');

    // Wait for exit timer to complete
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(modalManager.getActive(), null, 'Modal unmounts after exit transition completes');
    assert.equal(modalManager.getIsClosing(), false);
  });
});
