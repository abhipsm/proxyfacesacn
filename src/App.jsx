import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import FaceScan from './pages/FaceScan';
import AdminLogin from './pages/AdminLogin';
import Dashboard from './pages/Dashboard';
import AddStudent from './pages/AddStudent';
import { useState, useEffect } from 'react';
import { supabase } from './lib/supabase';

function App() {
  const [session, setSession] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <Router>
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <Navbar session={session} />
        <main className="flex-grow container mx-auto px-4 py-8 max-w-7xl">
          <Routes>
            <Route path="/" element={<FaceScan />} />
            <Route 
              path="/admin" 
              element={session ? <Navigate to="/dashboard" /> : <AdminLogin />} 
            />
            <Route 
              path="/dashboard" 
              element={session ? <Dashboard /> : <Navigate to="/admin" />} 
            />
            <Route 
              path="/add-student" 
              element={session ? <AddStudent /> : <Navigate to="/admin" />} 
            />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
