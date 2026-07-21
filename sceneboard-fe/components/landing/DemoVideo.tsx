'use client';

import { useState } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import styles from './LandingPage.module.css';

const DEFAULT_DEMO_VIDEO_URL = 'https://media.sceneboard.dev/demo/sceneboard-demo-3min.mp4';

export function DemoVideo() {
  const { t } = useI18n();
  const configuredUrl = process.env.NEXT_PUBLIC_SCENEBOARD_DEMO_VIDEO_URL?.trim();
  const videoUrl = configuredUrl || DEFAULT_DEMO_VIDEO_URL;
  const [unavailable, setUnavailable] = useState(false);

  return (
    <div className={styles.videoFrame}>
      {unavailable ? (
        <div className={styles.videoFallback} role="status">
          <span className={styles.playGlyph} aria-hidden="true">
            ▶
          </span>
          <strong>{t('landing.videoUnavailableTitle')}</strong>
          <span>{t('landing.videoUnavailableBody')}</span>
        </div>
      ) : (
        <video
          className={styles.video}
          controls
          playsInline
          preload="metadata"
          poster="/images/sceneboard-demo-poster.png"
          aria-label={t('landing.videoAria')}
          aria-describedby="demo-transcript"
          onError={() => setUnavailable(true)}
        >
          <source src={videoUrl} type="video/mp4" />
        </video>
      )}
    </div>
  );
}
