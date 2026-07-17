'use client';

import Link from 'next/link';

import { useI18n } from '../../../components/i18n/I18nProvider';
import styles from './skill-install-guide.module.css';

export function SkillInstallGuide() {
  const { t } = useI18n();

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
      <ol className={styles.steps}>
        <li>
          <span className={styles.number} aria-hidden="true">1</span>
          <div><h3>{t('ai.skillStepDownloadTitle')}</h3><p>{t('ai.skillStepDownloadBody')}</p></div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">2</span>
          <div>
            <h3>{t('ai.skillStepInstallTitle')}</h3>
            <p>{t('ai.skillStepInstallBody')}</p>
            <p className={styles.note}>{t('ai.skillRestartNote')}</p>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">3</span>
          <div><h3>{t('ai.skillStepConnectTitle')}</h3><p>{t('ai.skillStepConnectBody')}</p></div>
        </li>
      </ol>
      <p className={styles.prerequisite}>{t('ai.skillMcpPrerequisite')}</p>
    </section>
  );
}
