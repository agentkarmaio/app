/**
 * Golden fixture: every Celo x402 relayer settlement indexed into the
 * `celo_x402_settlements` quarantine table between 2026-10-29 14:01 and
 * 2026-10-30 06:40 UTC (4,327 rows), aggregated per payer→payee edge.
 * Addresses are public on-chain. The first five edges are the 5-wallet ring.
 */

import type { PaymentEdge } from './payment-cycles';

export const CELO_RING = [
  '0x4b116e9ea9281404cb21cc3bc06a2a9fe65a192d',
  '0x073840135e4885a8fd734dff5ddf29e841c335dd',
  '0xc431887c3c37aed25555ad748431a766dc1f1168',
  '0x047c79adb6b33a240f6ecfcb11c983764c198a18',
  '0x486b1f52b092d4cf77f621d5fb63160b18a8715f',
] as const;

export const CELO_RELAYER_EDGES_2026_10_30: PaymentEdge[] = [
  { payer: '0x4b116e9ea9281404cb21cc3bc06a2a9fe65a192d', payee: '0x073840135e4885a8fd734dff5ddf29e841c335dd', count: 772, value: 74.9012 },
  { payer: '0xc431887c3c37aed25555ad748431a766dc1f1168', payee: '0x047c79adb6b33a240f6ecfcb11c983764c198a18', count: 723, value: 66.947235 },
  { payer: '0x073840135e4885a8fd734dff5ddf29e841c335dd', payee: '0xc431887c3c37aed25555ad748431a766dc1f1168', count: 703, value: 64.473601 },
  { payer: '0x486b1f52b092d4cf77f621d5fb63160b18a8715f', payee: '0x4b116e9ea9281404cb21cc3bc06a2a9fe65a192d', count: 701, value: 67.675162 },
  { payer: '0x047c79adb6b33a240f6ecfcb11c983764c198a18', payee: '0x486b1f52b092d4cf77f621d5fb63160b18a8715f', count: 693, value: 65.079924 },
  { payer: '0x388097b8047cdcab7e2c7fe67fc42adfae1fe1ea', payee: '0x20faaca5f980e29639a0fcc6dca6988e18ed333b', count: 160, value: 1.6 },
  { payer: '0x3d5ea1ce6f3fa5fae7a38b77f569570b3ea9a9a4', payee: '0x20faaca5f980e29639a0fcc6dca6988e18ed333b', count: 101, value: 0.505 },
  { payer: '0x613d7095b6af6bfa719cbc6bdbfb5e6ebd7c1c28', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 25, value: 0.17063 },
  { payer: '0xeb9ee0896a3806ba7ca0277b0e110d58ecc9215c', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 24, value: 0.147754 },
  { payer: '0x500493cb7e0cc86302730b779ec2c35e7278b3bd', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 24, value: 0.14813 },
  { payer: '0xdba9ed20a33f1755c3c7e0d0cf7df480b6e9e7c9', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 23, value: 0.186626 },
  { payer: '0x228624e469af02b5c9f9c43b532737991811fd39', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 23, value: 0.14344 },
  { payer: '0x7035bc95185cdba3d8781fa1ce8e81e5f891f488', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 23, value: 0.14969 },
  { payer: '0x234c2c9b9672655e0bb080cb5ded4847eab1d184', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 22, value: 0.176814 },
  { payer: '0x07c1bf3590fa31ed4c1263833d063cbbe6149bab', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 22, value: 0.134192 },
  { payer: '0x83270ba356f28012960b25bc7a1d512af034ebd4', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 22, value: 0.164314 },
  { payer: '0xd13e63e72089dca2924da9d0326f921e4b652adb', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 22, value: 0.139502 },
  { payer: '0x7b06eba60ff11c9e0581feae0fbf4002a2054a61', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 22, value: 0.17094 },
  { payer: '0x6905d33ffffdb06abd6521c50ea604ad035aea17', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 22, value: 0.152378 },
  { payer: '0xcb6611cb9d5a932911f0d7bee91b563c8d3a484e', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 21, value: 0.148628 },
  { payer: '0xe59b7cfcc1549c714514d027010fba267adcba1f', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 21, value: 0.148064 },
  { payer: '0xbe945e99d15e16108ff2d12c2ae6d2d33340c98c', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 21, value: 0.124004 },
  { payer: '0xb93fe335d303247933247a1a5d1b47e554456f9b', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 21, value: 0.129314 },
  { payer: '0x0b7e7112a68cbda5766f153636bcc1f778797f51', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 21, value: 0.14219 },
  { payer: '0x6581774231bd7b8c331d776243e351a6fba63fb7', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 21, value: 0.130254 },
  { payer: '0x4a3dc673044deb18e639fc667612b3bc7bc2860f', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 18, value: 0.112002 },
  { payer: '0xa5947f477e4251b8c20cd6b40cba2bb1cc8c4d27', payee: '0x9478b729d8fe37575fe79fde6259e0179a839d15', count: 17, value: 0.108252 },
  { payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', payee: '0xb8491f953e6860d3b5840b73c60883ff099ceafa', count: 12, value: 0.025 },
  { payer: '0x8e222916c845da23e78c8688402ed1e922dbc9c0', payee: '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c', count: 5, value: 5.07 },
  { payer: '0x618baf4be1ad71e4f00f83c76130a87643ed9bf3', payee: '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c', count: 4, value: 6.58 },
  { payer: '0xf5614dd66b94501abeeb4c473c748452de7cf292', payee: '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c', count: 4, value: 3.99 },
  { payer: '0x2cf616ec10b20af1822c7bfaec2e98a6e4251ba3', payee: '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c', count: 4, value: 2.45 },
  { payer: '0x205a92b7d69e2a0628ce928c4e3d3ac29d67c90f', payee: '0xa137b7886f13b9903564b7b9236d12a7a7732e0f', count: 4, value: 0.2 },
  { payer: '0x7e0316b2533f6df2e651295a9b11481bb8346c3c', payee: '0x20faaca5f980e29639a0fcc6dca6988e18ed333b', count: 3, value: 0.012636 },
  { payer: '0xe4d88c9a86bd42d4f5d05a234e6d56f71bb58582', payee: '0x20faaca5f980e29639a0fcc6dca6988e18ed333b', count: 3, value: 0.02 },
];
