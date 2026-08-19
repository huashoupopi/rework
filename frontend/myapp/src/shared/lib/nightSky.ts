export function isNightSkyHour(date = new Date()) {
  const hour = date.getHours()
  return hour >= 22 || hour < 6
}
