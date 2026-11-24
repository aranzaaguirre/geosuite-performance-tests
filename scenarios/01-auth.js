import { authenticate } from '../lib/auth.js';
import { profileOptions } from '../lib/profiles.js';
import { credentialsForVu } from '../lib/session.js';

/*
 * Escenario 01: autenticación completa de un usuario GeoSuite.
 *
 * Delega en lib/auth.js el flujo NextAuth -> Keycloak OIDC -> callback ->
 * sesión -> validación del token en Django/GeoNode. No imprime credenciales,
 * cookies ni tokens. La capacidad de login se mide separada de los flujos de
 * navegación para no mezclar sus tiempos de respuesta.
 */

export const options = profileOptions('auth', 2000);

export default function () {
  authenticate(credentialsForVu());
}
