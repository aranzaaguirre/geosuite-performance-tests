/*
 * Perfiles comunes de ejecución.
 *
 * functional es el modo predeterminado y conserva la validación de una sola
 * iteración. Los demás perfiles se parametrizan mediante variables PROFILE_*
 * para reutilizar la misma definición en local, Nimbus e IDCE.
 */

const SUPPORTED_PROFILES = [
  'functional',
  'baseline',
  'load',
  'stress',
  'spike',
  'recovery',
];

function positiveInteger(name, fallback) {
  const value = Number(__ENV[name] || fallback);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} debe ser un entero mayor que cero`
    );
  }

  return value;
}

function duration(name, fallback) {
  return String(__ENV[name] || fallback);
}

export function selectedProfile() {
  const profile = String(
    __ENV.TEST_PROFILE || 'functional'
  ).toLowerCase();

  if (!SUPPORTED_PROFILES.includes(profile)) {
    throw new Error(
      `TEST_PROFILE no soportado: ${profile}`
    );
  }

  return profile;
}

function commonOptions(flow, profile, p95) {
  const p95Limit = positiveInteger(
    'PROFILE_P95_MS',
    p95
  );

  return {
    tags: {
      flow,
      test_profile: profile,
    },
    thresholds: {
      auth_session_valid: ['rate==1'],
      checks: ['rate>0.99'],
      http_req_failed: ['rate<0.01'],
      http_req_duration: [
        `p(95)<${p95Limit}`,
      ],
    },
  };
}

export function profileOptions(flow, p95 = 2000) {
  const profile = selectedProfile();
  const common = commonOptions(flow, profile, p95);

  if (profile === 'functional') {
    return {
      ...common,
      vus: 1,
      iterations: 1,
    };
  }

  if (profile === 'baseline') {
    return {
      ...common,
      scenarios: {
        [flow]: {
          executor: 'constant-vus',
          vus: positiveInteger('PROFILE_VUS', 3),
          duration: duration(
            'PROFILE_DURATION',
            '2m'
          ),
          gracefulStop: duration(
            'PROFILE_GRACEFUL_STOP',
            '30s'
          ),
        },
      },
    };
  }

  const stageDuration = duration(
    'PROFILE_STAGE_DURATION',
    '1m'
  );
  const holdDuration = duration(
    'PROFILE_HOLD_DURATION',
    '3m'
  );
  const recoveryDuration = duration(
    'PROFILE_RECOVERY_DURATION',
    '2m'
  );
  const target = positiveInteger(
    'PROFILE_VUS',
    profile === 'spike' ? 20 : 10
  );
  const base = positiveInteger('PROFILE_BASE_VUS', 2);

  let stages;

  if (profile === 'load') {
    stages = [
      {
        duration: stageDuration,
        target: Math.max(1, Math.ceil(target / 2)),
      },
      { duration: holdDuration, target },
      { duration: stageDuration, target: 0 },
    ];
  } else if (profile === 'stress') {
    stages = [
      { duration: stageDuration, target },
      { duration: holdDuration, target },
      { duration: stageDuration, target: target * 2 },
      { duration: holdDuration, target: target * 2 },
      { duration: stageDuration, target: target * 3 },
      { duration: holdDuration, target: target * 3 },
      { duration: recoveryDuration, target: 0 },
    ];
  } else if (profile === 'spike') {
    stages = [
      { duration: stageDuration, target: base },
      { duration: '15s', target },
      { duration: holdDuration, target },
      { duration: '15s', target: base },
      { duration: recoveryDuration, target: 0 },
    ];
  } else {
    stages = [
      { duration: stageDuration, target: target },
      { duration: holdDuration, target },
      { duration: stageDuration, target: base },
      { duration: recoveryDuration, target: base },
      { duration: stageDuration, target: 0 },
    ];
  }

  return {
    ...common,
    scenarios: {
      [flow]: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages,
        gracefulRampDown: duration(
          'PROFILE_GRACEFUL_RAMP_DOWN',
          '30s'
        ),
      },
    },
  };
}
