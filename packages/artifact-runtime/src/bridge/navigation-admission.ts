import type { ArtifactBridgeMessageV1, ArtifactNavigationIntentV1 } from './envelope.js';

export class ArtifactNavigationAdmissionV1 {
  #armed = false;
  #pointerId: number | null = null;

  setEnabled(enabled: boolean): Extract<ArtifactNavigationIntentV1, { type: 'artifact.navigation.pan.cancel' }> | null {
    this.#armed = enabled;
    return null;
  }

  admit(message: ArtifactBridgeMessageV1, active: boolean): message is ArtifactNavigationIntentV1 {
    if (!active) return false;
    if (!this.#armed) {
      if (message.type !== 'artifact.navigation.pan.cancel' || message.pointerId !== this.#pointerId) return false;
      this.#pointerId = null;
      return true;
    }
    if (message.type === 'artifact.navigation.wheel') return this.#pointerId === null;
    if (message.type === 'artifact.navigation.pan.start') {
      if (this.#pointerId !== null) return false;
      this.#pointerId = message.pointerId;
      return true;
    }
    if (message.type === 'artifact.navigation.pan.move') return this.#pointerId === message.pointerId;
    if (message.type === 'artifact.navigation.pan.end' || message.type === 'artifact.navigation.pan.cancel') {
      if (this.#pointerId !== message.pointerId) return false;
      this.#pointerId = null;
      return true;
    }
    return false;
  }
}
