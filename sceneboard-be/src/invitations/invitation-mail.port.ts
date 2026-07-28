import nodemailer, { type Transporter } from 'nodemailer';

export interface InvitationMailPort {
  sendInvitation(input: {
    to: string;
    boardTitle: string;
    role: 'editor' | 'viewer';
    token: string;
  }): Promise<void>;
}

export class GmailInvitationMailer implements InvitationMailPort {
  private readonly transporter: Transporter;

  constructor(
    private readonly config: {
      user: string;
      appPassword: string;
      browserOrigin: string;
    },
  ) {
    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
      auth: { user: config.user, pass: config.appPassword },
    });
  }

  async sendInvitation(input: {
    to: string;
    boardTitle: string;
    role: 'editor' | 'viewer';
    token: string;
  }): Promise<void> {
    const url = new URL('/invitations/accept', this.config.browserOrigin);
    url.searchParams.set('token', input.token);
    await this.transporter.sendMail({
      from: { name: 'SceneBoard', address: this.config.user },
      to: input.to,
      subject: `[SceneBoard] ${input.boardTitle} 보드 초대`,
      text: `${input.boardTitle} 보드의 ${input.role}로 초대되었습니다.\n\n${url.toString()}`,
      html: `<p><strong>${escapeHtml(input.boardTitle)}</strong> 보드의 ${input.role}로 초대되었습니다.</p><p><a href="${escapeHtml(url.toString())}">초대 수락</a></p>`,
    });
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
