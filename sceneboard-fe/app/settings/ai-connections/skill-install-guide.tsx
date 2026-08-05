'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useI18n } from '../../../components/i18n/I18nProvider';
import {
  resolveSceneBoardAgentInstallGuideUrl,
  SCENEBOARD_AGENT_INSTALL_GUIDE_URL,
} from '../../../lib/ai-connections/agent-install-guide';
import styles from './skill-install-guide.module.css';

export function SkillInstallGuide() {
  const { t } = useI18n();
  const [guideUrl, setGuideUrl] = useState(SCENEBOARD_AGENT_INSTALL_GUIDE_URL);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setGuideUrl(resolveSceneBoardAgentInstallGuideUrl(window.location.origin));
  }, []);

  async function copyGuideUrl() {
    try {
      await navigator.clipboard.writeText(guideUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={styles.guide} aria-labelledby="skill-install-title">
      <header className={styles.header}>
        <div>
          <p className="eyebrow">Codex + SceneBoard</p>
          <h2 id="skill-install-title">{t('ai.skillGuideTitle')}</h2>
          <p className="muted">{t('ai.skillGuideDescription')}</p>
        </div>
        <Link className="button" href="/integrations/codex">
          {t('ai.skillDownload')}
        </Link>
      </header>
      <aside className={styles.agentInstall}>
        <div>
          <strong>{t('codex.installTitle')}</strong>
          <p>{t('codex.installBody')}</p>
          <code>{guideUrl}</code>
        </div>
        <button type="button" className="button" onClick={() => void copyGuideUrl()}>
          {copied ? t('codex.copied') : t('codex.copy')}
        </button>
      </aside>
      <h3 className={styles.manualTitle}>{t('codex.commandTitle')}</h3>
      <ol className={styles.steps}>
        <li>
          <span className={styles.number} aria-hidden="true">
            1
          </span>
          <div>
            <h3>{t('ai.skillStepDownloadTitle')}</h3>
            <p>{t('ai.skillStepDownloadBody')}</p>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">
            2
          </span>
          <div>
            <h3>{t('ai.skillStepInstallTitle')}</h3>
            <p>{t('ai.skillStepInstallBody')}</p>
            <p className={styles.note}>{t('ai.skillRestartNote')}</p>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">
            3
          </span>
          <div>
            <h3>{t('ai.skillStepConnectTitle')}</h3>
            <p>{t('ai.skillStepConnectBody')}</p>
          </div>
        </li>
      </ol>
      <p className={styles.prerequisite}>{t('ai.skillMcpPrerequisite')}</p>
    </section>
  );
}
