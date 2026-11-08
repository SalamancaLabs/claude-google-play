android {
    namespace = "com.example.habitly"
    defaultConfig {
        applicationId = "com.example.habitly"
    }
}
dependencies {
    implementation("com.example.sdk:sample-sdk:1.2.3")
    implementation(project(":other"))
}
