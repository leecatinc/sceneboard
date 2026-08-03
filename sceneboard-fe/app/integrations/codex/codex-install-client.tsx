'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Brand } from '../../../components/app/Brand';
import { LanguageSelect } from '../../../components/i18n/LanguageSelect';
import { useI18n } from '../../../components/i18n/I18nProvider';
import type { MessageKey } from '../../../lib/i18n/catalog';
import styles from './codex-install.module.css';

const INSTALL_COMMAND = `codex plugin marketplace add leecatinc/sceneboard
codex plugin add sceneboard@sceneboard`;
const UPDATE_COMMAND = `codex plugin marketplace upgrade sceneboard
codex plugin add sceneboard@sceneboard`;
const REMOVE_COMMAND = 'codex plugin remove sceneboard@sceneboard';

function CopyBlock({ value, labelKey }: { value: string; labelKey: MessageKey }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.copyBlock}>
      <div className={styles.copyHead}>
        <strong>{t(labelKey)}</strong>
        <button type="button" onClick={() => void copy()}>
          {copied ? t('codex.copied') : t('codex.copy')}
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}

export function CodexInstallClient() {
  const { t } = useI18n();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brandLink} href="/boards">
          <Brand />
        </Link>
        <nav className={styles.headerActions} aria-label={t('nav.primary')}>
          <Link href="/login">{t('codex.signIn')}</Link>
          <div className={styles.language}>
            <LanguageSelect id="codex-language" />
          </div>
        </nav>
      </header>

      <main id="main-content" className={styles.main}>
        <section className={styles.hero}>
          <div>
            <p className="eyebrow">{t('codex.eyebrow')}</p>
            <h1>{t('codex.pageTitle')}</h1>
            <p>{t('codex.pageDescription')}</p>
            <div className={styles.heroActions}>
              <a className="button" href="#install">
                {t('codex.installTitle')}
              </a>
              <a
                className="button secondary"
                href="/downloads/sceneboard-codex-plugin.zip"
                download="sceneboard-codex-plugin.zip"
              >
                {t('codex.downloadArchive')}
              </a>
            </div>
          </div>
          <div className={styles.logoCard} aria-hidden="true">
            <svg viewBox="0 0 64 64">
              <path d="M14 14h27a6 6 0 0 1 6 6v31H20a6 6 0 0 1-6-6V14Z" />
              <path
                className={styles.spark}
                d="M49 4c1.1 7.4 4.6 10.9 12 12-7.4 1.1-10.9 4.6-12 12-1.1-7.4-4.6-10.9-12-12C44.4 14.9 47.9 11.4 49 4Z"
              />
            </svg>
          </div>
        </section>

        <aside className={styles.launchNotice}>
          <strong>{t('codex.statusTitle')}</strong>
          <p>{t('codex.statusBody')}</p>
          <code>https://sceneboard.dev</code>
        </aside>

        <section className={styles.section} id="install">
          <div className={styles.sectionHeading}>
            <span>01</span>
            <div>
              <h2>{t('codex.installTitle')}</h2>
              <p>{t('codex.installBody')}</p>
            </div>
          </div>
          <div className={styles.installGrid}>
            <CopyBlock value={t('codex.installPrompt')} labelKey="codex.askCodex" />
            <CopyBlock value={INSTALL_COMMAND} labelKey="codex.commandTitle" />
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}>
            <span>02</span>
            <div>
              <h2>{t('codex.configTitle')}</h2>
              <p>{t('codex.configBody')}</p>
            </div>
          </div>
          <ol className={styles.priorityList}>
            <li>
              <b>1</b>
              <div>
                <strong>{t('codex.projectOverride')}</strong>
                <code>&lt;project&gt;/.mcp.json</code>
              </div>
            </li>
            <li>
              <b>2</b>
              <div>
                <strong>{t('codex.codexConfig')}</strong>
                <code>&lt;project&gt;/.codex/config.toml → $CODEX_HOME/config.toml</code>
              </div>
            </li>
            <li>
              <b>3</b>
              <div>
                <strong>{t('codex.productionDefault')}</strong>
                <code>https://sceneboard.dev</code>
              </div>
            </li>
          </ol>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}>
            <span>03</span>
            <div>
              <h2>{t('codex.authorizeTitle')}</h2>
              <p>{t('codex.authorizeBody')}</p>
            </div>
          </div>
          <Link className="button" href="/settings/ai-connections">
            {t('codex.openConnections')}
          </Link>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}>
            <span>04</span>
            <div>
              <h2>{t('codex.maintenanceTitle')}</h2>
              <p>{t('codex.archiveNote')}</p>
            </div>
          </div>
          <div className={styles.installGrid}>
            <CopyBlock value={UPDATE_COMMAND} labelKey="codex.update" />
            <CopyBlock value={REMOVE_COMMAND} labelKey="codex.remove" />
          </div>
        </section>
      </main>
    </div>
  );
}
