plugins { id("com.android.application") }

android {
    namespace = "dev.example.nativeandroid"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig {
        applicationId = "dev.example.nativeandroid"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-ads:23.0.0")
}
