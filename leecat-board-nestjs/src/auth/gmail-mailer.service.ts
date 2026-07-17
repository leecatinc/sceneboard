import nodemailer, { type Transporter } from 'nodemailer';

import type { EmailVerificationLocale } from './auth.dto.js';

export interface VerificationEmailPort {
  sendVerificationCode(input: {
    to: string;
    code: string;
    locale: EmailVerificationLocale;
  }): Promise<void>;
}

interface VerificationEmailCopy {
  subject: string;
  heading: string;
  instruction: string;
  expiry: string;
  ignore: string;
}

const COPY: Readonly<Record<EmailVerificationLocale, VerificationEmailCopy>> = {
  en: {
    subject: '[SceneBoard] Verify your email',
    heading: 'Verify your SceneBoard email',
    instruction: 'Enter the verification code below to continue creating your workspace.',
    expiry: 'This code is valid for 10 minutes.',
    ignore: 'If you did not request this, you can safely ignore this email.',
  },
  ko: {
    subject: '[SceneBoard] 이메일 인증 코드',
    heading: 'SceneBoard 이메일 인증',
    instruction: '워크스페이스 생성을 계속하려면 아래 인증 코드를 입력해 주세요.',
    expiry: '이 코드는 10분간 유효합니다.',
    ignore: '직접 요청하지 않았다면 이 메일을 무시하셔도 됩니다.',
  },
  ja: {
    subject: '[SceneBoard] メール認証コード',
    heading: 'SceneBoard メール認証',
    instruction: 'ワークスペースの作成を続けるには、以下の認証コードを入力してください。',
    expiry: 'このコードは10分間有効です。',
    ignore: 'このリクエストに心当たりがない場合は、このメールを無視してください。',
  },
  'zh-CN': {
    subject: '[SceneBoard] 邮箱验证码',
    heading: '验证 SceneBoard 邮箱',
    instruction: '请输入以下验证码以继续创建工作区。',
    expiry: '此验证码在10分钟内有效。',
    ignore: '如果这不是你的操作，请忽略此邮件。',
  },
  'zh-TW': {
    subject: '[SceneBoard] 電子郵件驗證碼',
    heading: '驗證 SceneBoard 電子郵件',
    instruction: '請輸入以下驗證碼以繼續建立工作區。',
    expiry: '此驗證碼在10分鐘內有效。',
    ignore: '如果這不是您的操作，請忽略此郵件。',
  },
  es: {
    subject: '[SceneBoard] Código de verificación',
    heading: 'Verifica tu correo de SceneBoard',
    instruction: 'Introduce el siguiente código para continuar creando tu espacio de trabajo.',
    expiry: 'Este código es válido durante 10 minutos.',
    ignore: 'Si no solicitaste esto, puedes ignorar este correo.',
  },
  fr: {
    subject: '[SceneBoard] Code de vérification',
    heading: 'Vérifiez votre adresse SceneBoard',
    instruction: 'Saisissez le code ci-dessous pour poursuivre la création de votre espace de travail.',
    expiry: 'Ce code est valable pendant 10 minutes.',
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.',
  },
  de: {
    subject: '[SceneBoard] Bestätigungscode',
    heading: 'SceneBoard-E-Mail bestätigen',
    instruction: 'Gib den folgenden Code ein, um deinen Arbeitsbereich weiter einzurichten.',
    expiry: 'Dieser Code ist 10 Minuten gültig.',
    ignore: 'Wenn du dies nicht angefordert hast, kannst du diese E-Mail ignorieren.',
  },
  'pt-BR': {
    subject: '[SceneBoard] Código de verificação',
    heading: 'Verifique seu e-mail do SceneBoard',
    instruction: 'Digite o código abaixo para continuar criando seu espaço de trabalho.',
    expiry: 'Este código é válido por 10 minutos.',
    ignore: 'Se você não fez esta solicitação, ignore este e-mail.',
  },
  ru: {
    subject: '[SceneBoard] Код подтверждения',
    heading: 'Подтвердите почту SceneBoard',
    instruction: 'Введите код ниже, чтобы продолжить создание рабочего пространства.',
    expiry: 'Код действителен в течение 10 минут.',
    ignore: 'Если вы не запрашивали код, просто проигнорируйте это письмо.',
  },
};

export class GmailMailerService implements VerificationEmailPort {
  private readonly transporter: Transporter;

  constructor(private readonly config: { user: string; appPassword: string }) {
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

  async sendVerificationCode(input: {
    to: string;
    code: string;
    locale: EmailVerificationLocale;
  }): Promise<void> {
    const copy = COPY[input.locale];
    await this.transporter.sendMail({
      from: { name: 'SceneBoard', address: this.config.user },
      to: input.to,
      subject: copy.subject,
      text: `${copy.heading}\n\n${copy.instruction}\n\n${input.code}\n\n${copy.expiry}\n${copy.ignore}`,
      html: verificationHtml(input.locale, input.code, copy),
    });
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }
}

const verificationHtml = (
  locale: EmailVerificationLocale,
  code: string,
  copy: VerificationEmailCopy,
): string => `<!doctype html>
<html lang="${locale}">
  <body style="margin:0;background:#f4fbf9;color:#10243e;font-family:Arial,'Noto Sans',sans-serif;">
    <div style="max-width:520px;margin:0 auto;padding:36px 20px;">
      <div style="margin-bottom:18px;font-size:20px;font-weight:800;">SceneBoard</div>
      <div style="background:#ffffff;border:1px solid #d9e4e2;border-radius:12px;padding:30px;">
        <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;">${copy.heading}</h1>
        <p style="margin:0;color:#526172;line-height:1.65;">${copy.instruction}</p>
        <div style="margin:24px 0;padding:18px;border-radius:9px;background:#ecf8f5;color:#10243e;text-align:center;font-size:34px;font-weight:800;letter-spacing:9px;">${code}</div>
        <p style="margin:0 0 8px;color:#526172;font-size:14px;">${copy.expiry}</p>
        <p style="margin:0;color:#7a8795;font-size:13px;">${copy.ignore}</p>
      </div>
    </div>
  </body>
</html>`;
