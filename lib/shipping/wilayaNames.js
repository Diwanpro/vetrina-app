// Latin/French wilaya names expected by Yalidine's API (to_wilaya_name /
// from_wilaya_name). The app's canonical source is lib/wilayas.js (Arabic);
// this is an outbound mapping only, keyed by the official two-digit code.
// Communes are resolved separately through shipping_territories.

export const YALIDINE_WILAYA_NAMES = Object.freeze({
  '01': 'Adrar', '02': 'Chlef', '03': 'Laghouat', '04': 'Oum El Bouaghi',
  '05': 'Batna', '06': 'Bejaia', '07': 'Biskra', '08': 'Bechar',
  '09': 'Blida', '10': 'Bouira', '11': 'Tamanrasset', '12': 'Tebessa',
  '13': 'Tlemcen', '14': 'Tiaret', '15': 'Tizi Ouzou', '16': 'Alger',
  '17': 'Djelfa', '18': 'Jijel', '19': 'Setif', '20': 'Saida',
  '21': 'Skikda', '22': 'Sidi Bel Abbes', '23': 'Annaba', '24': 'Guelma',
  '25': 'Constantine', '26': 'Medea', '27': 'Mostaganem', '28': "M'Sila",
  '29': 'Mascara', '30': 'Ouargla', '31': 'Oran', '32': 'El Bayadh',
  '33': 'Illizi', '34': 'Bordj Bou Arreridj', '35': 'Boumerdes', '36': 'El Tarf',
  '37': 'Tindouf', '38': 'Tissemsilt', '39': 'El Oued', '40': 'Khenchela',
  '41': 'Souk Ahras', '42': 'Tipaza', '43': 'Mila', '44': 'Ain Defla',
  '45': 'Naama', '46': 'Ain Temouchent', '47': 'Ghardaia', '48': 'Relizane',
  '49': 'Timimoun', '50': 'Bordj Badji Mokhtar', '51': 'Ouled Djellal',
  '52': 'Beni Abbes', '53': 'Ain Salah', '54': 'Ain Guezzam',
  '55': 'Touggourt', '56': 'Djanet', '57': "El M'Ghair", '58': 'El Meniaa',
})

export function yalidineWilayaName(code) {
  return YALIDINE_WILAYA_NAMES[String(code ?? '').padStart(2, '0')] || ''
}
