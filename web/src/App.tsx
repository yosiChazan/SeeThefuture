import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './auth/AuthGate';
import { Layout } from './components/Layout';
import { ClientCard } from './pages/ClientCard';
import { Clients } from './pages/Clients';
import { Dashboard } from './pages/Dashboard';
import { Intake } from './pages/Intake';
import { IntakeBatch } from './pages/IntakeBatch';
import { Leases } from './pages/Leases';
import { Properties } from './pages/Properties';
import { PropertyCard } from './pages/PropertyCard';

export function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="properties" element={<Properties />} />
            <Route path="properties/:id" element={<PropertyCard />} />
            <Route path="clients" element={<Clients />} />
            <Route path="clients/:id" element={<ClientCard />} />
            <Route path="leases" element={<Leases />} />
            <Route path="intake" element={<Intake />} />
            <Route path="intake/:id" element={<IntakeBatch />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthGate>
  );
}
