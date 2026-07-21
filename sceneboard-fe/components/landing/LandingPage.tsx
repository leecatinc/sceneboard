'use client';

import Link from 'next/link';

import type { MessageKey } from '../../lib/i18n/catalog';
import { BrandMark } from '../app/Brand';
import { useI18n } from '../i18n/I18nProvider';
import { DemoVideo } from './DemoVideo';
import { LandingLanguageSelect } from './LandingLanguageSelect';
import { LandingSessionActions } from './LandingSessionActions';
import styles from './LandingPage.module.css';

const valueCards = [
  {
    number: '01',
    titleKey: 'landing.valueContextTitle',
    bodyKey: 'landing.valueContextBody',
  },
  {
    number: '02',
    titleKey: 'landing.valueDecisionTitle',
    bodyKey: 'landing.valueDecisionBody',
  },
  {
    number: '03',
    titleKey: 'landing.valueRevisionTitle',
    bodyKey: 'landing.valueRevisionBody',
  },
] as const satisfies ReadonlyArray<{
  number: string;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}>;

const visualModes = [
  ['landing.modeDocumentTitle', 'landing.modeDocumentBody'],
  ['landing.modeDiagramTitle', 'landing.modeDiagramBody'],
  ['landing.modeCanvasTitle', 'landing.modeCanvasBody'],
  ['landing.modePrototypeTitle', 'landing.modePrototypeBody'],
  ['landing.modeWebglTitle', 'landing.modeWebglBody'],
] as const satisfies ReadonlyArray<readonly [MessageKey, MessageKey]>;

export function LandingPage() {
  const { locale, t } = useI18n();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label={t('landing.homeLabel')}>
          <BrandMark size={27} />
          <span>SceneBoard</span>
        </Link>
        <nav className={styles.nav} aria-label={t('landing.productNavigation')}>
          <a href="#why">{t('landing.navWhy')}</a>
          <a href="#decision-workspace">{t('landing.navHumanControl')}</a>
          <a href="#open-source">{t('landing.navOpenSource')}</a>
        </nav>
        <div className={styles.headerActions}>
          <LandingLanguageSelect />
          <LandingSessionActions />
        </div>
      </header>

      <main id="main-content">
        <section className={styles.hero} aria-label={t('landing.heroAria')}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>{t('landing.heroEyebrow')}</p>
            <h1 data-locale={locale}>
              {t('landing.heroTitleBase')}
              <br />
              <span>{t('landing.heroTitleLead')}</span>
            </h1>
            <p className={styles.heroLead}>{t('landing.heroLead')}</p>
            <div className={styles.heroActions}>
              <a className={styles.primaryAction} href="#demo">
                {t('landing.watchDemo')}
              </a>
              <Link className={styles.secondaryAction} href="/signup">
                {t('auth.createAccount')}
              </Link>
            </div>
            <p className={styles.heroNote}>{t('landing.heroNote')}</p>
          </div>

          <div className={styles.heroBoard} aria-label={t('landing.briefingAria')}>
            <div className={styles.boardChrome}>
              <span className={styles.liveDot} />
              {t('board.liveScene')}
              <span>{t('boards.revision', { number: 6 })}</span>
            </div>
            <div className={styles.boardContent}>
              <div className={styles.aiInput}>
                <span>{t('landing.receivedLabel')}</span>
                <code>{t('landing.receivedCode')}</code>
                <small>{t('landing.compressedLabel')}</small>
              </div>
              <div className={styles.transformArrow} aria-hidden="true">
                →
              </div>
              <div className={styles.humanOutput}>
                <span>{t('landing.reviewerLabel')}</span>
                <strong>{t('landing.checkoutTitle')}</strong>
                <p>{t('landing.checkoutBody')}</p>
                <small>{t('landing.ruleReasonConsequence')}</small>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.demoSection} id="demo" aria-labelledby="demo-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>{t('landing.demoEyebrow')}</p>
            <h2 id="demo-title">{t('landing.demoTitle')}</h2>
            <p>{t('landing.demoBody')}</p>
          </div>
          <DemoVideo />
          <p className={styles.transcript} id="demo-transcript">
            {t('landing.demoTranscript')}
          </p>
        </section>

        <section className={styles.valueSection} id="why" aria-labelledby="why-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>{t('landing.navWhy')}</p>
            <h2 id="why-title">{t('landing.whyTitle')}</h2>
            <p>{t('landing.whyBody')}</p>
          </div>
          <div className={styles.valueGrid}>
            {valueCards.map((card) => (
              <article className={styles.valueCard} key={card.number}>
                <span>{card.number}</span>
                <h3>{t(card.titleKey)}</h3>
                <p>{t(card.bodyKey)}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          className={styles.decisionSection}
          id="decision-workspace"
          aria-labelledby="decision-title"
        >
          <div className={styles.decisionCopy}>
            <p className={styles.eyebrow}>{t('landing.decisionEyebrow')}</p>
            <h2 id="decision-title">{t('landing.decisionTitle')}</h2>
            <p>{t('landing.decisionBody')}</p>
            <ul>
              <li>{t('landing.decisionReason')}</li>
              <li>{t('landing.decisionChanges')}</li>
              <li>{t('landing.decisionEvidence')}</li>
              <li>{t('landing.decisionConsequence')}</li>
            </ul>
          </div>
          <div className={styles.decisionCard}>
            <div className={styles.decisionHeader}>
              <span>{t('hitl.decisionWorkspace')}</span>
              <span>{t('landing.reversibleChoice')}</span>
            </div>
            <h3>{t('landing.riskTitle')}</h3>
            <p>{t('landing.riskBody')}</p>
            <div className={styles.choiceSelected}>
              <span aria-hidden="true" />
              <div>
                <strong>{t('landing.inventoryTitle')}</strong>
                <small>{t('landing.inventoryBody')}</small>
              </div>
            </div>
            <div className={styles.choice}>
              <span aria-hidden="true" />
              <div>
                <strong>{t('landing.duplicateTitle')}</strong>
                <small>{t('landing.duplicateBody')}</small>
              </div>
            </div>
            <button type="button" tabIndex={-1} aria-hidden="true">
              {t('landing.submitResponse')}
            </button>
          </div>
        </section>

        <section className={styles.visualSection} aria-labelledby="visual-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>{t('landing.visualEyebrow')}</p>
            <h2 id="visual-title">{t('landing.visualTitle')}</h2>
          </div>
          <div className={styles.visualGrid}>
            {visualModes.map(([titleKey, bodyKey], index) => (
              <article key={titleKey}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h3>{t(titleKey)}</h3>
                <p>{t(bodyKey)}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.openSourceSection} id="open-source">
          <div>
            <p className={styles.eyebrow}>{t('landing.openEyebrow')}</p>
            <h2>{t('landing.openTitle')}</h2>
          </div>
          <div>
            <p>{t('landing.openBody')}</p>
            <a
              className={styles.secondaryAction}
              href="https://github.com/leecatinc/sceneboard"
              target="_blank"
              rel="noreferrer"
            >
              {t('landing.viewGithub')}
            </a>
          </div>
        </section>

        <section className={styles.finalCta}>
          <BrandMark size={42} />
          <h2>{t('landing.finalTitle')}</h2>
          <p>{t('landing.finalBody')}</p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/signup">
              {t('auth.createAccount')}
            </Link>
            <Link className={styles.secondaryAction} href="/login">
              {t('auth.signIn')}
            </Link>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>{t('landing.footerCreated')}</span>
        <div className={styles.footerLinks}>
          <a
            href="https://github.com/leecatinc/sceneboard"
            target="_blank"
            rel="noreferrer"
            aria-label={t('landing.viewGithub')}
          >
            GitHub
          </a>
          <span>{t('landing.footerLicense')}</span>
        </div>
      </footer>
    </div>
  );
}
