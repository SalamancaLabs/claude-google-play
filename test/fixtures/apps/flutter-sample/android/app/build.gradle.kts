android {
    namespace = "com.example.habitly"
    defaultConfig {
        applicationId = "com.example.habitly"
    }
}
dependencies {
    implementation("com.example.sdk:sample-sdk:1.2.3")
    implementation(project(":other"))
    implementation(libs.okhttp)
    testImplementation(libs.junit.lib)
    testImplementation("com.example.test:mock:9.9")
}
dependencies {
    implementation(platform("com.example.bom:sample-bom:5.0.0"))
    implementation("com.example.bom:managed-lib")
}
