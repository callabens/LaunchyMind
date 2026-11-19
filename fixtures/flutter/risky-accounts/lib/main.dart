import 'package:camera/camera.dart';
import 'package:firebase_auth/firebase_auth.dart';

const String privacyPolicyUrl = 'https://launchymind.invalid/privacy';
const String accountDeletionUrl = 'https://launchymind.invalid/delete-account';

class AccountPage {
  Future<void> deleteAccount() async {
    await FirebaseAuth.instance.currentUser?.delete();
  }
}
