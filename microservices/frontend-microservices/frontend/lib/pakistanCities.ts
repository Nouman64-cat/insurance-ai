export interface CityCoords {
  lat: number;
  lng: number;
  province: string;
}

// Coordinates for Pakistan's major cities. Keys are lowercase for lookup;
// display names are stored via the `name` implied by the lookup key itself.
export const PAKISTAN_CITIES: Record<string, CityCoords> = {
  karachi: { lat: 24.8607, lng: 67.0011, province: "Sindh" },
  lahore: { lat: 31.5497, lng: 74.3436, province: "Punjab" },
  islamabad: { lat: 33.6844, lng: 73.0479, province: "Islamabad Capital Territory" },
  rawalpindi: { lat: 33.5651, lng: 73.0169, province: "Punjab" },
  faisalabad: { lat: 31.4504, lng: 73.135, province: "Punjab" },
  multan: { lat: 30.1575, lng: 71.5249, province: "Punjab" },
  peshawar: { lat: 34.0151, lng: 71.5249, province: "Khyber Pakhtunkhwa" },
  quetta: { lat: 30.1798, lng: 66.975, province: "Balochistan" },
  hyderabad: { lat: 25.396, lng: 68.3578, province: "Sindh" },
  sialkot: { lat: 32.4945, lng: 74.5229, province: "Punjab" },
  gujranwala: { lat: 32.1877, lng: 74.1945, province: "Punjab" },
  sargodha: { lat: 32.0836, lng: 72.6711, province: "Punjab" },
  bahawalpur: { lat: 29.3956, lng: 71.6836, province: "Punjab" },
  sukkur: { lat: 27.7052, lng: 68.8574, province: "Sindh" },
  larkana: { lat: 27.5589, lng: 68.212, province: "Sindh" },
  abbottabad: { lat: 34.1463, lng: 73.2117, province: "Khyber Pakhtunkhwa" },
  mardan: { lat: 34.1986, lng: 72.0404, province: "Khyber Pakhtunkhwa" },
  sahiwal: { lat: 30.6682, lng: 73.1114, province: "Punjab" },
  "rahim yar khan": { lat: 28.4212, lng: 70.2989, province: "Punjab" },
  gujrat: { lat: 32.5738, lng: 74.0789, province: "Punjab" },
  jhelum: { lat: 32.9425, lng: 73.7257, province: "Punjab" },
  sheikhupura: { lat: 31.7131, lng: 73.9783, province: "Punjab" },
  mingora: { lat: 34.7717, lng: 72.3604, province: "Khyber Pakhtunkhwa" },
  "dera ghazi khan": { lat: 30.0561, lng: 70.6403, province: "Punjab" },
  "d.g. khan": { lat: 30.0561, lng: 70.6403, province: "Punjab" },
  nawabshah: { lat: 26.2442, lng: 68.41, province: "Sindh" },
  "mirpur khas": { lat: 25.5266, lng: 69.0113, province: "Sindh" },
  chiniot: { lat: 31.7202, lng: 72.9784, province: "Punjab" },
  kasur: { lat: 31.1157, lng: 74.4498, province: "Punjab" },
  okara: { lat: 30.8095, lng: 73.4457, province: "Punjab" },
  muzaffargarh: { lat: 30.0729, lng: 71.1922, province: "Punjab" },
  gilgit: { lat: 35.9208, lng: 74.3144, province: "Gilgit-Baltistan" },
  skardu: { lat: 35.2971, lng: 75.6333, province: "Gilgit-Baltistan" },
  muzaffarabad: { lat: 34.37, lng: 73.4711, province: "Azad Jammu & Kashmir" },
  mirpur: { lat: 33.1478, lng: 73.7511, province: "Azad Jammu & Kashmir" },
  turbat: { lat: 26.0031, lng: 63.0389, province: "Balochistan" },
  gwadar: { lat: 25.1264, lng: 62.3225, province: "Balochistan" },
  sibi: { lat: 29.5439, lng: 67.8781, province: "Balochistan" },
  "dera ismail khan": { lat: 31.831, lng: 70.9018, province: "Khyber Pakhtunkhwa" },
  "d.i. khan": { lat: 31.831, lng: 70.9018, province: "Khyber Pakhtunkhwa" },
  kohat: { lat: 33.5872, lng: 71.4451, province: "Khyber Pakhtunkhwa" },
  bannu: { lat: 32.9853, lng: 70.6026, province: "Khyber Pakhtunkhwa" },
  attock: { lat: 33.7666, lng: 72.3639, province: "Punjab" },
  jacobabad: { lat: 28.2769, lng: 68.4514, province: "Sindh" },
};

const CITY_KEYS = Object.keys(PAKISTAN_CITIES);

function toTitleCase(key: string): string {
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolves a free-text city name to known coordinates. Tries an exact
 * (case-insensitive) match first, then a substring match either way, since
 * lead/customer `city` fields are free text entered by agents.
 */
export function resolveCityCoords(name?: string | null): { name: string; coords: CityCoords } | null {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  if (!lower) return null;

  if (PAKISTAN_CITIES[lower]) {
    return { name: toTitleCase(lower), coords: PAKISTAN_CITIES[lower] };
  }

  const match = CITY_KEYS.find((key) => lower.includes(key) || key.includes(lower));
  if (match) {
    return { name: toTitleCase(match), coords: PAKISTAN_CITIES[match] };
  }

  return null;
}
