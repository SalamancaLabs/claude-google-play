import 'package:http/http.dart' as http;

const api = 'https://api.example.org/v1/habits';
// Policy: https://example.org/habitly/privacy-policy.
Future<void> sync() => http.get(Uri.parse('$api/sync'));
const dynamicUrl = 'https://${host}/x';
