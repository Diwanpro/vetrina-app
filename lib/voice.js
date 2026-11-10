export function speechResultText(results, processed) {
  let final = '', interim = ''
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.isFinal && !processed.has(index)) {
      processed.add(index)
      final += ` ${result[0].transcript}`
    } else if (!result.isFinal) interim += ` ${result[0].transcript}`
  }
  return { final: final.trim(), interim: interim.trim() }
}
export function appendDictation(previous, transcript, maxLength = 4000) {
  if (!transcript.trim()) return previous
  return `${previous}${previous && !/\s$/.test(previous) ? ' ' : ''}${transcript.trim()}`.slice(0, maxLength)
}
