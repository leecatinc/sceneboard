const analyticsMessage = <Key extends string>(key: Key, en: string, ko: string) =>
  [key, en, ko, en, en, en, en, en, en, en, en] as const;

export const ANALYTICS_CATALOG = [
  analyticsMessage('analytics.title', 'Share analytics', '공유 분석'),
  analyticsMessage(
    'analytics.rangeDescription',
    'Public and password share activity for the last 30 days.',
    '최근 30일간 공개 및 비밀번호 공유 활동입니다.',
  ),
  analyticsMessage(
    'analytics.loading',
    'Loading share analytics.',
    '공유 분석을 불러오는 중입니다.',
  ),
  analyticsMessage(
    'analytics.error',
    'Share analytics are unavailable.',
    '공유 분석을 불러올 수 없습니다.',
  ),
  analyticsMessage(
    'analytics.empty',
    'No share activity is available.',
    '표시할 공유 활동이 없습니다.',
  ),
  analyticsMessage(
    'analytics.delayed',
    'Aggregate updates are delayed. Recent activity may appear later.',
    '집계가 지연되고 있습니다. 최근 활동은 나중에 표시될 수 있습니다.',
  ),
  analyticsMessage('analytics.boardOpens', 'Board opens', '보드 열람'),
  analyticsMessage('analytics.pageViews', 'Page views', '페이지 조회'),
  analyticsMessage('analytics.generationPageViews', 'Generation page views', '세대 페이지 조회'),
  analyticsMessage('analytics.estimatedDailyReach', 'Estimated daily reach', '일간 도달 추정'),
  analyticsMessage('analytics.lastAggregated', 'Last aggregate', '최근 집계'),
  analyticsMessage(
    'analytics.tableCaption',
    'Publication and page breakdown',
    '게시 세대 및 페이지 내역',
  ),
  analyticsMessage('analytics.publication', 'Publication', '게시 세대'),
  analyticsMessage('analytics.generation', 'Generation', '세대'),
  analyticsMessage('analytics.page', 'Page', '페이지'),
  analyticsMessage('analytics.pageReach', 'Page reach', '페이지 도달률'),
  analyticsMessage(
    'analytics.reachDenominator',
    'Page reach uses board opens in the same publication generation as its denominator.',
    '페이지 도달률의 분모는 같은 게시 세대의 보드 열람 수입니다.',
  ),
] as const;
