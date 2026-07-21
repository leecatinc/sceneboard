import { Injectable } from '@nestjs/common';

import { CurrentArtifactRuntimeSummaryPort } from '../ports/current-artifact-runtime-summary.port.js';

@Injectable()
export class InactiveCurrentArtifactRuntimeSummaryProvider extends CurrentArtifactRuntimeSummaryPort {
  async readAuthorizedAtCut(): Promise<readonly []> {
    return [];
  }
}
