const row = <Key extends string>(key: Key, en: string, ko: string) =>
  [key, en, ko, en, en, en, en, en, en, en, en] as const;

export const MEDIA_AUTHORING_CATALOG = [
  row('mediaAuthoring.ready', 'Add an image', '이미지 추가'),
  row('mediaAuthoring.hashing', 'Checking image…', '이미지 확인 중…'),
  row('mediaAuthoring.uploading', 'Uploading image…', '이미지 업로드 중…'),
  row(
    'mediaAuthoring.uploadUncertain',
    'Upload confirmation was interrupted. Retry the same upload.',
    '업로드 확인이 중단되었습니다. 같은 업로드를 다시 시도하세요.',
  ),
  row(
    'mediaAuthoring.describe',
    'Describe the image before placing it.',
    '이미지를 배치하기 전에 설명을 입력하세요.',
  ),
  row('mediaAuthoring.placing', 'Placing image…', '이미지 배치 중…'),
  row(
    'mediaAuthoring.placementUncertain',
    'Placement confirmation was interrupted. Retry the same placement.',
    '배치 확인이 중단되었습니다. 같은 배치를 다시 시도하세요.',
  ),
  row(
    'mediaAuthoring.placementConflict',
    'The board changed. Review and retry placement.',
    '보드가 변경되었습니다. 확인 후 배치를 다시 시도하세요.',
  ),
  row('mediaAuthoring.success', 'Image placed', '이미지를 배치했습니다'),
  row(
    'mediaAuthoring.restart',
    'Your session changed. Select the image again.',
    '세션이 변경되었습니다. 이미지를 다시 선택하세요.',
  ),
  row(
    'mediaAuthoring.invalidFile',
    'Choose one PNG, JPEG, or WebP image up to 10 MB.',
    '10MB 이하 PNG, JPEG 또는 WebP 이미지 하나를 선택하세요.',
  ),
  row(
    'mediaAuthoring.invalidDescription',
    'Enter alternative text or mark the image as decorative.',
    '대체 텍스트를 입력하거나 장식용 이미지로 표시하세요.',
  ),
  row(
    'mediaAuthoring.placementUnavailable',
    'This image cannot be placed on the selected page.',
    '선택한 페이지에 이 이미지를 배치할 수 없습니다.',
  ),
  row(
    'mediaAuthoring.placementCollision',
    'The intended image position is already occupied.',
    '의도한 이미지 위치가 이미 사용 중입니다.',
  ),
  row('mediaAuthoring.dropLabel', 'Image upload drop zone', '이미지 업로드 드롭 영역'),
  row('mediaAuthoring.dropHint', 'Drop one image here', '이미지 하나를 여기에 놓으세요'),
  row('mediaAuthoring.picker', 'Choose image', '이미지 선택'),
  row('mediaAuthoring.alt', 'Alternative text', '대체 텍스트'),
  row('mediaAuthoring.decorative', 'Decorative image', '장식용 이미지'),
  row('mediaAuthoring.caption', 'Caption (optional)', '캡션(선택)'),
  row('mediaAuthoring.fit', 'Image fit', '이미지 맞춤'),
  row('mediaAuthoring.fit.contain', 'Contain', '전체 표시'),
  row('mediaAuthoring.fit.cover', 'Cover', '영역 채우기'),
  row('mediaAuthoring.fit.fill', 'Stretch', '늘려 채우기'),
  row('mediaAuthoring.fit.none', 'Original size', '원본 크기'),
  row('mediaAuthoring.retryUpload', 'Retry upload', '업로드 다시 시도'),
  row('mediaAuthoring.place', 'Place image', '이미지 배치'),
  row('mediaAuthoring.retryPlacement', 'Retry placement', '배치 다시 시도'),
  row(
    'mediaAuthoring.error.invalid',
    'The image upload was rejected.',
    '이미지 업로드가 거부되었습니다.',
  ),
  row(
    'mediaAuthoring.error.forbidden',
    'You no longer have permission to add images.',
    '이미지를 추가할 권한이 없습니다.',
  ),
  row(
    'mediaAuthoring.error.notFound',
    'This board is no longer available.',
    '이 보드를 사용할 수 없습니다.',
  ),
  row('mediaAuthoring.error.tooLarge', 'The image is too large.', '이미지 용량이 너무 큽니다.'),
  row(
    'mediaAuthoring.error.conflict',
    'This upload can no longer be retried.',
    '이 업로드는 더 이상 다시 시도할 수 없습니다.',
  ),
  row(
    'mediaAuthoring.error.rateLimited',
    'Too many uploads. Try again shortly.',
    '업로드 요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
  ),
  row(
    'mediaAuthoring.error.unavailable',
    'Image upload is temporarily unavailable.',
    '이미지 업로드를 일시적으로 사용할 수 없습니다.',
  ),
  row(
    'mediaAuthoring.error.generic',
    'The image could not be added.',
    '이미지를 추가하지 못했습니다.',
  ),
] as const;
