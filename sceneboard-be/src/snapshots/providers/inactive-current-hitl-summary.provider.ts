import { Injectable } from '@nestjs/common';

import { CurrentHitlSummaryPort } from '../ports/current-hitl-summary.port.js';

@Injectable()
export class InactiveCurrentHitlSummaryProvider extends CurrentHitlSummaryPort {
  async readAuthorizedAtCut(): Promise<readonly []> {
    return [];
  }
}
