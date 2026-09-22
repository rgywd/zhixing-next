import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">知行 Next</Text>
      <Text style={styles.subtitle}>让想法，走向行动。</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: '600',
    color: '#172033',
  },
  subtitle: {
    fontSize: 16,
    color: '#526078',
    textAlign: 'center',
  },
});
