const MAX_STATISTICS_CPUS = 256
const MAX_CPU_MODEL_LENGTH = 256

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function boundedCpuDetails(cpus) {
  if (!Array.isArray(cpus)) return []
  return cpus.slice(0, MAX_STATISTICS_CPUS).map((cpu) => ({
    model: typeof cpu?.model === 'string'
      ? [...cpu.model.slice(0, MAX_CPU_MODEL_LENGTH * 2)]
        .slice(0, MAX_CPU_MODEL_LENGTH).join('') : '',
    speed: finiteNonNegative(cpu?.speed),
    times: {
      user: finiteNonNegative(cpu?.times?.user),
      nice: finiteNonNegative(cpu?.times?.nice),
      sys: finiteNonNegative(cpu?.times?.sys),
      idle: finiteNonNegative(cpu?.times?.idle),
      irq: finiteNonNegative(cpu?.times?.irq),
    },
  }))
}

export { MAX_STATISTICS_CPUS, boundedCpuDetails }
